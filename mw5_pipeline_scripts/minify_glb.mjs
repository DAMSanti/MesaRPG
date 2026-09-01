import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, weld, resample, prune, meshopt } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'

await MeshoptEncoder.ready
await MeshoptDecoder.ready

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder })
const inPath = process.argv[2]
const outPath = process.argv[3]
const maxSize = Number(process.argv[4] || 2048)
const quality = Number(process.argv[5] || 82)

const doc = await io.read(inPath)

// Lossless-ish cleanup passes first (same as gltf-transform optimize would do,
// minus the buggy textureCompress step), then meshopt geometry+animation
// compression (EXT_meshopt_compression) — safe here since drei's useGLTF
// enables MeshoptDecoder by default at every single call site in this app
// (checked node_modules/@react-three/drei/core/Gltf.js directly), no extra
// wiring needed on the loading side.
await doc.transform(dedup(), weld(), resample(), prune(), meshopt({ encoder: MeshoptEncoder }))

const root = doc.getRoot()
const textures = root.listTextures()
console.log(`Processing ${textures.length} textures...`)

let totalBefore = 0
let totalAfter = 0

for (const tex of textures) {
  const image = tex.getImage()
  if (!image) continue
  const mime = tex.getMimeType()
  if (mime !== 'image/png' && mime !== 'image/jpeg') continue

  const before = image.byteLength
  totalBefore += before

  let pipeline = sharp(Buffer.from(image))
  const meta = await pipeline.metadata()
  if (meta.width > maxSize || meta.height > maxSize) {
    pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
  }
  const outBuf = await pipeline.webp({ quality, effort: 4 }).toBuffer()

  tex.setImage(outBuf)
  tex.setMimeType('image/webp')
  const name = tex.getName() || tex.getURI() || '(unnamed)'
  console.log(`  ${name}: ${meta.width}x${meta.height} ${(before / 1024).toFixed(0)}KB -> ${(outBuf.byteLength / 1024).toFixed(0)}KB`)
  totalAfter += outBuf.byteLength
}

console.log(`\nTexture total: ${(totalBefore / 1024 / 1024).toFixed(1)}MB -> ${(totalAfter / 1024 / 1024).toFixed(1)}MB`)

await io.write(outPath, doc)
console.log(`\nWrote: ${outPath}`)
