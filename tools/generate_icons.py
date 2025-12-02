"""
MesaRPG - Generador de iconos para PWA
Genera los iconos necesarios para la Progressive Web App
"""

from pathlib import Path

def generate_svg_icon():
    """Genera un icono SVG simple para MesaRPG"""
    svg = '''<?xml version="1.0" encoding="UTF-8"?>
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#1a1a2e"/>
            <stop offset="100%" style="stop-color:#16213e"/>
        </linearGradient>
        <linearGradient id="dice" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#ffd700"/>
            <stop offset="100%" style="stop-color:#ff8c00"/>
        </linearGradient>
    </defs>
    
    <!-- Background circle -->
    <circle cx="256" cy="256" r="250" fill="url(#bg)" stroke="#ffd700" stroke-width="8"/>
    
    <!-- D20 dice shape (simplified icosahedron view) -->
    <polygon 
        points="256,60 420,180 380,400 132,400 92,180" 
        fill="url(#dice)" 
        stroke="#1a1a2e" 
        stroke-width="4"
        opacity="0.9"/>
    
    <!-- Inner lines of dice -->
    <line x1="256" y1="60" x2="256" y2="320" stroke="#1a1a2e" stroke-width="3"/>
    <line x1="256" y1="320" x2="92" y2="180" stroke="#1a1a2e" stroke-width="3"/>
    <line x1="256" y1="320" x2="420" y2="180" stroke="#1a1a2e" stroke-width="3"/>
    <line x1="256" y1="320" x2="132" y2="400" stroke="#1a1a2e" stroke-width="3"/>
    <line x1="256" y1="320" x2="380" y2="400" stroke="#1a1a2e" stroke-width="3"/>
    
    <!-- Number 20 in center -->
    <text x="256" y="240" font-family="Arial Black, Arial, sans-serif" font-size="72" font-weight="bold" 
          fill="#1a1a2e" text-anchor="middle" dominant-baseline="middle">20</text>
    
    <!-- MesaRPG text at bottom -->
    <text x="256" y="460" font-family="Arial, sans-serif" font-size="48" font-weight="bold" 
          fill="#ffd700" text-anchor="middle">MesaRPG</text>
</svg>'''
    return svg


def main():
    base_dir = Path(__file__).parent.parent
    mobile_assets = base_dir / "mobile" / "assets"
    mobile_assets.mkdir(parents=True, exist_ok=True)
    
    # Generar SVG
    svg_content = generate_svg_icon()
    
    # Guardar como archivo SVG (que puede usarse directamente)
    svg_path = mobile_assets / "icon.svg"
    svg_path.write_text(svg_content, encoding='utf-8')
    print(f"✅ Generado: {svg_path}")
    
    # Intentar generar PNGs si Pillow está disponible
    try:
        from PIL import Image
        import cairosvg
        import io
        
        for size in [192, 512]:
            png_data = cairosvg.svg2png(bytestring=svg_content.encode(), 
                                        output_width=size, output_height=size)
            png_path = mobile_assets / f"icon-{size}.png"
            png_path.write_bytes(png_data)
            print(f"✅ Generado: {png_path}")
            
    except ImportError:
        print("ℹ️  Para generar PNGs, instala: pip install cairosvg pillow")
        print("   Mientras tanto, puedes convertir el SVG manualmente a PNG")
        
        # Crear placeholder PNGs simples
        try:
            from PIL import Image, ImageDraw
            
            for size in [192, 512]:
                img = Image.new('RGBA', (size, size), (26, 26, 46, 255))
                draw = ImageDraw.Draw(img)
                
                # Círculo exterior
                margin = size // 20
                draw.ellipse([margin, margin, size-margin, size-margin], 
                            fill=(22, 33, 62, 255), outline=(255, 215, 0, 255), width=size//60)
                
                # Dado simplificado (hexágono)
                center = size // 2
                hex_size = size // 3
                hex_points = []
                import math
                for i in range(6):
                    angle = math.pi / 6 + i * math.pi / 3
                    x = center + hex_size * math.cos(angle)
                    y = center + hex_size * math.sin(angle)
                    hex_points.append((x, y))
                
                draw.polygon(hex_points, fill=(255, 215, 0, 255), outline=(26, 26, 46, 255))
                
                # Texto "20"
                try:
                    from PIL import ImageFont
                    font_size = size // 6
                    font = ImageFont.truetype("arial.ttf", font_size)
                    draw.text((center, center), "20", fill=(26, 26, 46, 255), 
                             font=font, anchor="mm")
                except:
                    pass
                
                png_path = mobile_assets / f"icon-{size}.png"
                img.save(png_path, 'PNG')
                print(f"✅ Generado (placeholder): {png_path}")
                
        except ImportError:
            print("⚠️  Pillow no está instalado. Instala con: pip install pillow")
            print("   Los iconos necesitarán ser creados manualmente.")
    
    print("\n🎲 Iconos generados en:", mobile_assets)


if __name__ == "__main__":
    main()
