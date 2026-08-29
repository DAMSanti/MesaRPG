import * as THREE from 'three'

/** Turning one part of a rigged mech into a standalone, physical-looking
 * piece: the geometry baking and recentering behind MechLab's limb-break
 * preview.
 *
 * Extracted from MechLabView when the board needed the same thing. Real
 * user report: "las extremidades directamente desaparecen... debe ser como
 * en el mechlab, los brazos cayendo por gravedad hasta que colisionan con
 * el suelo." The board had its own naive version that drew a limb's RAW
 * geometry, which is the exact bug MechLab already hit and documented
 * below ("se rompe desde el centro del modelo, no desde el punto donde
 * esta") -- a skinned mesh's raw vertex data sits near the armature
 * origin, nowhere near where the part actually renders. There is one
 * correct way to do this and it now lives in one place.
 */

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const PICKING_EDGE_LENGTH_MULTIPLIER = 6
const _pickA = new THREE.Vector3()
const _pickB = new THREE.Vector3()
const _pickC = new THREE.Vector3()
/** The actual filter — pulled out of buildPickingGeometry so the SAME
 * cleaning can run on any geometry, not just a mesh's own raw one. Real
 * bug found this session: the physics colliders (see spawnFallingBody
 * and the static-collider effect below) were built from RAW baked
 * geometry, spike triangles and all — the Torso's own collider ballooned
 * out toward the shoulder for the exact same reason its raycasting once
 * did, so a piece could spawn already overlapping it and get stuck
 * ("las piezas clipean... no colisiona con la pierna"). Both picking AND
 * physics now clean through this same function, so there's only one
 * definition of "this part's real shape" to keep correct.
 *
 * Real bug found in THIS function next, from reusing it for a VISIBLE
 * mesh (the falling stand-in) instead of only ever an invisible picking
 * proxy as before: it only ever kept the position attribute, silently
 * dropping uv/normal — invisible on a proxy nothing ever renders, but a
 * real stand-in mesh built from that lost its texture entirely ("la
 * malla rota y sin texturizar"). Every attribute the source geometry
 * actually has now survives filtering, re-indexed the same way position
 * already was. */
export function filterLongEdgeTriangles(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const triCount = Math.floor((index ? index.count : position.count) / 3)
  const vertexIndex = (i: number) => (index ? index.getX(i) : i)
  const edgeLens: number[] = []
  for (let t = 0; t < triCount; t++) {
    _pickA.fromBufferAttribute(position, vertexIndex(t * 3))
    _pickB.fromBufferAttribute(position, vertexIndex(t * 3 + 1))
    _pickC.fromBufferAttribute(position, vertexIndex(t * 3 + 2))
    edgeLens.push(Math.max(_pickA.distanceTo(_pickB), _pickB.distanceTo(_pickC), _pickA.distanceTo(_pickC)))
  }
  const threshold = median(edgeLens) * PICKING_EDGE_LENGTH_MULTIPLIER
  const keptTriangles: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (edgeLens[t] <= threshold) keptTriangles.push(t)
  }
  const cleaned = new THREE.BufferGeometry()
  for (const name of Object.keys(geometry.attributes)) {
    const srcAttr = geometry.getAttribute(name) as THREE.BufferAttribute
    const itemSize = srcAttr.itemSize
    const out = new Float32Array(keptTriangles.length * 3 * itemSize)
    let w = 0
    for (const t of keptTriangles) {
      for (const offset of [0, 1, 2]) {
        const vi = vertexIndex(t * 3 + offset)
        for (let c = 0; c < itemSize; c++) out[w++] = srcAttr.getComponent(vi, c)
      }
    }
    cleaned.setAttribute(name, new THREE.Float32BufferAttribute(out, itemSize))
  }
  return cleaned
}

/** Real bug found this session (live-browser confirmed, then reported
 * directly by the user: "se rompe desde el centro del modelo, no desde
 * el punto donde esta"): a SkinnedMesh's own raw `geometry` position
 * data is expressed relative to the Armature's own local origin, NOT
 * anywhere near where the piece actually renders — for this rig, EVERY
 * named mesh node sits directly under Armature with an identity local
 * transform, so `mesh.matrixWorld` alone is ~the world origin for all
 * five of them regardless of which body part they are. The REAL
 * position only ever comes from skinning (the bone matrices), which a
 * plain (non-skinned) stand-in Mesh — built to sidestep a SEPARATE
 * modelViewMatrix-staleness bug found earlier this session with
 * reparenting a live SkinnedMesh — never applies at all.
 * `SkinnedMesh.getVertexPosition()` (three.js's own built-in per-vertex
 * skinning evaluator, confirmed present in this project's three.js
 * version by reading its own source) bakes the CURRENT bind-pose
 * skinning into a real position, in the mesh's own local space —
 * exactly the "transformed" value its vertex shader itself computes
 * before `modelViewMatrix` gets applied. Baking that into a plain,
 * non-skinned geometry ONCE (this preview never animates, so the bind
 * pose it bakes never goes stale) is what actually lets
 * `mesh.matrixWorld` alone correctly place a plain-mesh stand-in — and,
 * since a Rapier collider needs real vertex data too, is exactly what
 * the physics colliders below are built from as well. */
export function bakeSkinnedGeometry(mesh: THREE.SkinnedMesh, geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const baked = geometry.clone()
  const position = baked.getAttribute('position') as THREE.BufferAttribute
  const target = new THREE.Vector3()
  for (let i = 0; i < position.count; i++) {
    mesh.getVertexPosition(i, target)
    position.setXYZ(i, target.x, target.y, target.z)
  }
  position.needsUpdate = true
  baked.computeVertexNormals()
  return baked
}

export interface BakedPiece {
  /** The FULL baked geometry — every original triangle, nothing excluded
   * — recentered so local (0,0,0) is now this piece's own bounding-box
   * center, not wherever the source mesh's own local origin happened to
   * be (near the model's own center for this rig, since every named
   * mesh node sits directly under Armature). Real user report ("las
   * piezas clipean... no colisiona con la pierna") traced to exactly
   * this un-recentered origin: a Rapier rigid body's own `.translation()`
   * always tracks whatever origin its collider was declared around, NOT
   * its visual bulk — with the old (un-recentered) collider built far
   * from that origin, the body's own tracked position barely moved while
   * the actual geometry swung through space around it instead, throwing
   * off both the resting behavior and real contact with the rest of the
   * model. Recentering means a body's own tracked origin finally
   * coincides with where its piece visually IS.
   *
   * Real SEPARATE bug found after shipping the first version of this:
   * `halfExtents`/the recenter offset used to be computed by running
   * filterLongEdgeTriangles (see its own doc comment — built for an
   * INVISIBLE picking proxy, where over-excluding a few real triangles
   * along with the actual junk is harmless) directly on the geometry
   * that then became the VISIBLE stand-in mesh — on parts with real,
   * legitimately long edges (a leg's own flat panels, not just the
   * arm's known seam-cap junk), that cut real surface away too, leaving
   * a visible hole showing the model's own hollow interior ("hay trozos
   * que no tienen textura y se ve el interior del modelo", confirmed on
   * both an arm and a leg). The FULL geometry is what actually renders
   * now; filtering only ever informs `halfExtents` below (an invisible
   * collider's own size), never what gets drawn. */
  geometry: THREE.BufferGeometry
  worldPosition: THREE.Vector3
  worldQuaternion: THREE.Quaternion
  /** Uniform for every part on this rig (confirmed: every named mesh
   * node's own matrixWorld carries the same scale, since none of them
   * have any per-node scale of their own — see mechAssets.ts's own
   * curated-rig doc comments) — a single scalar is enough. */
  scale: number
  halfExtents: THREE.Vector3
}

/** `visualGeometry` is exactly what renders (see BakedPiece's own doc
 * comment on `geometry` for why it must stay the FULL, unfiltered
 * shape) — `filterLongEdgeTriangles` only ever runs on a throwaway
 * clone here, purely to size/place the invisible collider without
 * letting known junk (a handful of stray or seam-cap triangles) balloon
 * it out. */
export function recenterBakedPiece(visualGeometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): BakedPiece {
  const cleanedForBounds = filterLongEdgeTriangles(visualGeometry)
  cleanedForBounds.computeBoundingBox()
  const box = cleanedForBounds.boundingBox!
  const localCenter = new THREE.Vector3()
  box.getCenter(localCenter)
  const localSize = new THREE.Vector3()
  box.getSize(localSize)
  cleanedForBounds.dispose()

  visualGeometry.translate(-localCenter.x, -localCenter.y, -localCenter.z)
  visualGeometry.computeBoundingBox()

  const worldScale = new THREE.Vector3()
  const worldQuaternion = new THREE.Quaternion()
  matrixWorld.decompose(new THREE.Vector3(), worldQuaternion, worldScale)
  const worldPosition = localCenter.applyMatrix4(matrixWorld)

  return {
    geometry: visualGeometry, worldPosition, worldQuaternion, scale: worldScale.x,
    halfExtents: localSize.multiplyScalar(0.5 * worldScale.x),
  }
}

export function buildBakedPiece(mesh: THREE.SkinnedMesh, geometry: THREE.BufferGeometry): BakedPiece {
  return recenterBakedPiece(bakeSkinnedGeometry(mesh, geometry), mesh.matrixWorld)
}
