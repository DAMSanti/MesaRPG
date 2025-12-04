"""
MesaRPG - Generador de Tokens de Alta Calidad
Genera tokens SVG detallados para D&D y BattleTech
"""

from pathlib import Path
import json


def generate_dnd_token_svg(token_id: str, name: str, class_type: str, colors: dict) -> str:
    """Genera un token SVG de alta calidad para D&D"""
    
    primary = colors.get('primary', '#6366f1')
    secondary = colors.get('secondary', '#4f46e5')
    accent = colors.get('accent', '#ffd700')
    
    # Iconos SVG detallados por clase
    class_icons = {
        'barbarian': '''
            <path d="M64 25 L75 45 L95 45 L80 60 L85 80 L64 70 L43 80 L48 60 L33 45 L53 45 Z" 
                  fill="none" stroke="white" stroke-width="3" stroke-linejoin="round"/>
            <path d="M50 50 L64 35 L78 50" fill="none" stroke="white" stroke-width="2"/>
            <circle cx="64" cy="55" r="4" fill="white"/>
        ''',
        'bard': '''
            <ellipse cx="64" cy="55" rx="15" ry="20" fill="none" stroke="white" stroke-width="2.5"/>
            <path d="M79 55 L79 30 M79 33 Q85 30 85 38 Q85 43 79 42" fill="none" stroke="white" stroke-width="2"/>
            <line x1="52" y1="45" x2="76" y2="45" stroke="white" stroke-width="1.5"/>
            <line x1="52" y1="52" x2="76" y2="52" stroke="white" stroke-width="1.5"/>
            <line x1="52" y1="59" x2="76" y2="59" stroke="white" stroke-width="1.5"/>
            <line x1="52" y1="66" x2="76" y2="66" stroke="white" stroke-width="1.5"/>
        ''',
        'cleric': '''
            <rect x="58" y="30" width="12" height="50" rx="2" fill="white"/>
            <rect x="44" y="42" width="40" height="12" rx="2" fill="white"/>
            <circle cx="64" cy="48" r="8" fill="{primary}" stroke="white" stroke-width="2"/>
        ''',
        'druid': '''
            <path d="M64 30 Q50 45 50 60 Q50 75 64 80 Q78 75 78 60 Q78 45 64 30" 
                  fill="none" stroke="white" stroke-width="2.5"/>
            <path d="M64 40 Q58 50 60 60 Q62 70 64 72 Q66 70 68 60 Q70 50 64 40" 
                  fill="white" opacity="0.8"/>
            <circle cx="58" cy="50" r="3" fill="white"/>
            <circle cx="70" cy="50" r="3" fill="white"/>
        ''',
        'fighter': '''
            <path d="M64 25 L64 75" stroke="white" stroke-width="4" stroke-linecap="round"/>
            <path d="M50 35 L78 35 L74 40 L54 40 Z" fill="white"/>
            <rect x="55" y="70" width="18" height="8" rx="2" fill="white"/>
            <circle cx="64" cy="45" r="6" fill="{primary}" stroke="white" stroke-width="2"/>
        ''',
        'monk': '''
            <circle cx="64" cy="38" r="12" fill="none" stroke="white" stroke-width="2.5"/>
            <path d="M52 55 Q52 75 64 80 Q76 75 76 55" fill="none" stroke="white" stroke-width="2.5"/>
            <circle cx="64" cy="38" r="5" fill="white"/>
            <path d="M55 60 L50 70 M73 60 L78 70" stroke="white" stroke-width="2" stroke-linecap="round"/>
        ''',
        'paladin': '''
            <path d="M64 25 L78 40 L78 65 L64 80 L50 65 L50 40 Z" 
                  fill="none" stroke="white" stroke-width="2.5"/>
            <path d="M64 35 L64 70" stroke="white" stroke-width="3"/>
            <path d="M52 50 L76 50" stroke="white" stroke-width="3"/>
            <circle cx="64" cy="50" r="6" fill="{accent}"/>
        ''',
        'ranger': '''
            <path d="M64 25 L64 60" stroke="white" stroke-width="3" stroke-linecap="round"/>
            <path d="M64 25 L55 35 M64 25 L73 35" stroke="white" stroke-width="2"/>
            <path d="M45 75 Q64 55 83 75" fill="none" stroke="white" stroke-width="2.5"/>
            <circle cx="64" cy="45" r="4" fill="white"/>
        ''',
        'rogue': '''
            <path d="M64 25 L68 75" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M60 25 L56 75" stroke="white" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
            <path d="M55 30 L73 30 L70 38 L58 38 Z" fill="white"/>
            <ellipse cx="64" cy="55" rx="12" ry="8" fill="none" stroke="white" stroke-width="1.5" stroke-dasharray="4,2"/>
        ''',
        'sorcerer': '''
            <circle cx="64" cy="50" r="18" fill="none" stroke="white" stroke-width="2"/>
            <path d="M64 32 L68 45 L80 48 L70 55 L72 68 L64 60 L56 68 L58 55 L48 48 L60 45 Z" 
                  fill="white" opacity="0.9"/>
            <circle cx="64" cy="50" r="6" fill="{accent}"/>
        ''',
        'warlock': '''
            <ellipse cx="64" cy="50" rx="20" ry="25" fill="none" stroke="white" stroke-width="2"/>
            <circle cx="64" cy="45" r="10" fill="white"/>
            <ellipse cx="64" cy="45" rx="4" ry="8" fill="{primary}"/>
            <path d="M50 70 Q64 60 78 70" fill="none" stroke="white" stroke-width="2"/>
        ''',
        'wizard': '''
            <path d="M64 20 L75 55 L85 78 L64 68 L43 78 L53 55 Z" 
                  fill="none" stroke="white" stroke-width="2.5"/>
            <circle cx="64" cy="45" r="8" fill="white"/>
            <path d="M56 45 L72 45 M64 37 L64 53" stroke="{primary}" stroke-width="2"/>
            <circle cx="64" cy="45" r="3" fill="{accent}"/>
        ''',
    }
    
    # Iconos para razas/monstruos
    race_icons = {
        'dwarf': '''
            <rect x="50" y="35" width="28" height="35" rx="5" fill="none" stroke="white" stroke-width="2.5"/>
            <path d="M50 55 Q40 70 50 75 L78 75 Q88 70 78 55" fill="none" stroke="white" stroke-width="2"/>
            <ellipse cx="64" cy="42" rx="8" ry="5" fill="white"/>
            <rect x="56" y="48" width="16" height="4" fill="white"/>
        ''',
        'elf': '''
            <ellipse cx="64" cy="45" rx="12" ry="15" fill="none" stroke="white" stroke-width="2"/>
            <path d="M52 40 L40 30 M76 40 L88 30" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <circle cx="58" cy="42" r="2" fill="white"/>
            <circle cx="70" cy="42" r="2" fill="white"/>
            <path d="M60 52 Q64 56 68 52" fill="none" stroke="white" stroke-width="1.5"/>
        ''',
        'human': '''
            <circle cx="64" cy="40" r="12" fill="none" stroke="white" stroke-width="2.5"/>
            <path d="M52 55 L52 75 L76 75 L76 55" fill="none" stroke="white" stroke-width="2.5"/>
            <circle cx="60" cy="38" r="2" fill="white"/>
            <circle cx="68" cy="38" r="2" fill="white"/>
            <path d="M60 45 Q64 48 68 45" fill="none" stroke="white" stroke-width="1.5"/>
        ''',
        'halfling': '''
            <circle cx="64" cy="45" r="15" fill="none" stroke="white" stroke-width="2.5"/>
            <circle cx="58" cy="42" r="3" fill="white"/>
            <circle cx="70" cy="42" r="3" fill="white"/>
            <path d="M58 52 Q64 58 70 52" fill="none" stroke="white" stroke-width="2"/>
            <path d="M64 60 L64 75" stroke="white" stroke-width="3"/>
        ''',
        'dragonborn': '''
            <path d="M64 25 L80 45 L75 70 L64 80 L53 70 L48 45 Z" 
                  fill="none" stroke="white" stroke-width="2.5"/>
            <path d="M48 45 L40 35 M80 45 L88 35" stroke="white" stroke-width="2"/>
            <circle cx="56" cy="45" r="3" fill="{accent}"/>
            <circle cx="72" cy="45" r="3" fill="{accent}"/>
            <path d="M58 60 L64 55 L70 60 L64 70 Z" fill="white"/>
        ''',
        'tiefling': '''
            <circle cx="64" cy="48" r="14" fill="none" stroke="white" stroke-width="2"/>
            <path d="M50 35 Q48 20 55 25 M78 35 Q80 20 73 25" stroke="white" stroke-width="2.5"/>
            <circle cx="58" cy="45" r="2" fill="{accent}"/>
            <circle cx="70" cy="45" r="2" fill="{accent}"/>
            <path d="M64 70 Q64 85 58 90 M64 70 Q64 85 70 90" stroke="white" stroke-width="2"/>
        ''',
        'goblin': '''
            <ellipse cx="64" cy="50" rx="18" ry="15" fill="none" stroke="white" stroke-width="2"/>
            <path d="M46 45 L35 40 M82 45 L93 40" stroke="white" stroke-width="2"/>
            <circle cx="55" cy="48" r="4" fill="white"/>
            <circle cx="73" cy="48" r="4" fill="white"/>
            <path d="M56 60 L64 55 L72 60" fill="none" stroke="white" stroke-width="2"/>
        ''',
        'orc': '''
            <path d="M45 40 L64 30 L83 40 L80 70 L64 80 L48 70 Z" 
                  fill="none" stroke="white" stroke-width="2.5"/>
            <circle cx="55" cy="48" r="4" fill="white"/>
            <circle cx="73" cy="48" r="4" fill="white"/>
            <path d="M55 62 L58 58 M73 62 L70 58" stroke="white" stroke-width="3"/>
        ''',
        'skeleton': '''
            <circle cx="64" cy="40" r="14" fill="none" stroke="white" stroke-width="2"/>
            <circle cx="58" cy="38" r="4" fill="white"/>
            <circle cx="70" cy="38" r="4" fill="white"/>
            <path d="M58 50 L70 50" stroke="white" stroke-width="2"/>
            <path d="M58 50 L58 48 M62 50 L62 48 M66 50 L66 48 M70 50 L70 48" stroke="white" stroke-width="1"/>
            <path d="M55 55 L55 80 M64 55 L64 80 M73 55 L73 80" stroke="white" stroke-width="2"/>
        ''',
        'zombie': '''
            <circle cx="64" cy="42" r="14" fill="none" stroke="white" stroke-width="2" stroke-dasharray="3,2"/>
            <circle cx="58" cy="40" r="3" fill="white"/>
            <ellipse cx="70" cy="40" rx="4" ry="3" fill="white"/>
            <path d="M56 52 Q64 58 72 52" fill="none" stroke="white" stroke-width="2"/>
            <path d="M52 60 L50 80 M76 60 L78 80" stroke="white" stroke-width="3"/>
        ''',
    }
    
    icon = class_icons.get(class_type, '') or race_icons.get(class_type, '')
    icon = icon.replace('{primary}', primary).replace('{accent}', accent)
    
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <linearGradient id="bg_{token_id}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:{primary}"/>
            <stop offset="100%" style="stop-color:{secondary}"/>
        </linearGradient>
        <linearGradient id="shine_{token_id}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:white;stop-opacity:0.3"/>
            <stop offset="50%" style="stop-color:white;stop-opacity:0"/>
        </linearGradient>
        <filter id="shadow_{token_id}" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="2" dy="3" stdDeviation="4" flood-opacity="0.4"/>
        </filter>
        <clipPath id="circle_{token_id}">
            <circle cx="64" cy="64" r="58"/>
        </clipPath>
    </defs>
    
    <!-- Sombra exterior -->
    <circle cx="64" cy="66" r="56" fill="rgba(0,0,0,0.3)"/>
    
    <!-- Fondo principal -->
    <circle cx="64" cy="64" r="58" fill="url(#bg_{token_id})" filter="url(#shadow_{token_id})"/>
    
    <!-- Borde decorativo -->
    <circle cx="64" cy="64" r="58" fill="none" stroke="{accent}" stroke-width="3"/>
    <circle cx="64" cy="64" r="54" fill="none" stroke="{accent}" stroke-width="1" opacity="0.5"/>
    
    <!-- Brillo -->
    <ellipse cx="50" cy="45" rx="25" ry="20" fill="url(#shine_{token_id})" clip-path="url(#circle_{token_id})"/>
    
    <!-- Icono de clase -->
    <g transform="translate(0, 5)">
        {icon}
    </g>
    
    <!-- Nombre -->
    <text x="64" y="105" font-family="Arial, sans-serif" font-size="11" font-weight="bold"
          text-anchor="middle" fill="white" filter="url(#shadow_{token_id})">{name.upper()}</text>
</svg>'''


def generate_battletech_token_svg(token_id: str, name: str, tonnage: int, colors: dict) -> str:
    """Genera un token SVG hexagonal de alta calidad para BattleTech"""
    
    primary = colors.get('primary', '#4CAF50')
    secondary = colors.get('secondary', '#2E7D32')
    accent = colors.get('accent', '#81C784')
    
    # Clase de peso
    if tonnage <= 35:
        weight_class = "LIGHT"
        weight_color = "#4CAF50"
        weight_letter = "L"
    elif tonnage <= 55:
        weight_class = "MEDIUM"
        weight_color = "#2196F3"
        weight_letter = "M"
    elif tonnage <= 75:
        weight_class = "HEAVY"
        weight_color = "#FF9800"
        weight_letter = "H"
    else:
        weight_class = "ASSAULT"
        weight_color = "#f44336"
        weight_letter = "A"
    
    # Siluetas de mechs más detalladas
    mech_silhouettes = {
        'locust': '''
            <path d="M64 35 L68 40 L68 55 L72 58 L72 70 L68 72 L68 75 L60 75 L60 72 L56 70 L56 58 L60 55 L60 40 Z" 
                  fill="white" opacity="0.9"/>
            <circle cx="64" cy="38" r="5" fill="{primary}"/>
            <path d="M56 50 L50 45 M72 50 L78 45" stroke="white" stroke-width="2"/>
        ''',
        'commando': '''
            <path d="M64 32 L70 38 L70 50 L75 52 L75 68 L70 72 L70 78 L58 78 L58 72 L53 68 L53 52 L58 50 L58 38 Z" 
                  fill="white" opacity="0.9"/>
            <rect x="60" y="35" width="8" height="6" rx="1" fill="{primary}"/>
            <path d="M53 55 L45 50 M75 55 L83 50" stroke="white" stroke-width="2.5"/>
        ''',
        'jenner': '''
            <path d="M64 30 L72 38 L72 55 L78 58 L78 72 L72 75 L64 78 L56 75 L50 72 L50 58 L56 55 L56 38 Z" 
                  fill="white" opacity="0.9"/>
            <ellipse cx="64" cy="36" rx="6" ry="4" fill="{primary}"/>
            <path d="M50 60 L42 55 M78 60 L86 55" stroke="white" stroke-width="2"/>
            <rect x="58" y="62" width="12" height="8" fill="{primary}" opacity="0.5"/>
        ''',
        'atlas': '''
            <path d="M64 25 L78 35 L82 50 L82 70 L75 80 L64 85 L53 80 L46 70 L46 50 L50 35 Z" 
                  fill="white" opacity="0.95"/>
            <circle cx="64" cy="38" r="10" fill="{primary}"/>
            <circle cx="58" cy="36" r="3" fill="black"/>
            <circle cx="70" cy="36" r="3" fill="black"/>
            <rect x="55" y="50" width="18" height="15" rx="2" fill="{primary}" opacity="0.4"/>
            <path d="M46 55 L35 48 M82 55 L93 48" stroke="white" stroke-width="4"/>
            <path d="M53 80 L50 95 M75 80 L78 95" stroke="white" stroke-width="5"/>
        ''',
        'battlemaster': '''
            <path d="M64 28 L76 38 L80 52 L80 68 L74 78 L64 82 L54 78 L48 68 L48 52 L52 38 Z" 
                  fill="white" opacity="0.9"/>
            <rect x="56" y="32" width="16" height="10" rx="3" fill="{primary}"/>
            <path d="M48 55 L38 50 L35 55" stroke="white" stroke-width="3" fill="none"/>
            <path d="M80 55 L90 50 L93 55" stroke="white" stroke-width="3" fill="none"/>
            <rect x="55" y="55" width="18" height="12" fill="{primary}" opacity="0.3"/>
        ''',
        'marauder': '''
            <path d="M64 30 L74 40 L74 55 L80 58 L80 72 L74 78 L64 82 L54 78 L48 72 L48 58 L54 55 L54 40 Z" 
                  fill="white" opacity="0.9"/>
            <path d="M56 35 L58 32 L70 32 L72 35 L72 42 L56 42 Z" fill="{primary}"/>
            <path d="M48 60 L35 52 L32 58" stroke="white" stroke-width="3"/>
            <path d="M80 60 L93 52 L96 58" stroke="white" stroke-width="3"/>
        ''',
        'warhammer': '''
            <path d="M64 28 L75 38 L78 55 L78 70 L72 80 L64 84 L56 80 L50 70 L50 55 L53 38 Z" 
                  fill="white" opacity="0.9"/>
            <rect x="55" y="32" width="18" height="12" rx="2" fill="{primary}"/>
            <path d="M50 58 L32 50 L28 58 L32 62" stroke="white" stroke-width="3" fill="none"/>
            <path d="M78 58 L96 50 L100 58 L96 62" stroke="white" stroke-width="3" fill="none"/>
        ''',
        'catapult': '''
            <path d="M64 35 L72 42 L72 58 L78 62 L78 75 L64 82 L50 75 L50 62 L56 58 L56 42 Z" 
                  fill="white" opacity="0.9"/>
            <rect x="57" y="38" width="14" height="8" rx="2" fill="{primary}"/>
            <rect x="42" y="45" width="8" height="20" rx="2" fill="white"/>
            <rect x="78" y="45" width="8" height="20" rx="2" fill="white"/>
            <circle cx="46" cy="50" r="3" fill="{primary}"/>
            <circle cx="82" cy="50" r="3" fill="{primary}"/>
        ''',
    }
    
    # Silueta genérica si no hay específica
    default_silhouette = '''
        <path d="M64 32 L74 42 L74 55 L80 60 L80 72 L74 78 L64 82 L54 78 L48 72 L48 60 L54 55 L54 42 Z" 
              fill="white" opacity="0.9"/>
        <rect x="56" y="36" width="16" height="10" rx="2" fill="{primary}"/>
        <path d="M48 62 L38 55 M80 62 L90 55" stroke="white" stroke-width="3"/>
    '''
    
    silhouette = mech_silhouettes.get(token_id, default_silhouette)
    silhouette = silhouette.replace('{primary}', primary)
    
    hex_points = "64,6 116,35 116,93 64,122 12,93 12,35"
    hex_inner = "64,14 108,39 108,89 64,114 20,89 20,39"
    
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <linearGradient id="bg_{token_id}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:{primary}"/>
            <stop offset="100%" style="stop-color:{secondary}"/>
        </linearGradient>
        <linearGradient id="metal_{token_id}" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:#888"/>
            <stop offset="50%" style="stop-color:#555"/>
            <stop offset="100%" style="stop-color:#333"/>
        </linearGradient>
        <filter id="shadow_{token_id}" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="2" dy="3" stdDeviation="3" flood-opacity="0.4"/>
        </filter>
        <clipPath id="hex_{token_id}">
            <polygon points="{hex_points}"/>
        </clipPath>
    </defs>
    
    <!-- Sombra -->
    <polygon points="64,10 114,38 114,96 64,124 14,96 14,38" fill="rgba(0,0,0,0.3)"/>
    
    <!-- Hexágono principal -->
    <polygon points="{hex_points}" fill="url(#bg_{token_id})" filter="url(#shadow_{token_id})"/>
    
    <!-- Borde metálico -->
    <polygon points="{hex_points}" fill="none" stroke="url(#metal_{token_id})" stroke-width="4"/>
    <polygon points="{hex_inner}" fill="none" stroke="{accent}" stroke-width="1.5" opacity="0.6"/>
    
    <!-- Silueta del mech -->
    <g clip-path="url(#hex_{token_id})">
        {silhouette}
    </g>
    
    <!-- Badge de peso -->
    <circle cx="100" cy="22" r="14" fill="{weight_color}" stroke="#fff" stroke-width="2"/>
    <text x="100" y="27" font-family="Arial Black, sans-serif" font-size="14" font-weight="bold"
          text-anchor="middle" fill="white">{weight_letter}</text>
    
    <!-- Nombre del mech -->
    <text x="64" y="108" font-family="Arial, sans-serif" font-size="10" font-weight="bold"
          text-anchor="middle" fill="white">{name.upper()}</text>
    
    <!-- Tonelaje -->
    <text x="64" y="118" font-family="Arial, sans-serif" font-size="8"
          text-anchor="middle" fill="{accent}">{tonnage}T</text>
</svg>'''


def generate_generic_token_svg(number: int, color: str) -> str:
    """Genera un token genérico numerado de alta calidad"""
    
    # Colores derivados
    import colorsys
    
    # Convertir hex a RGB
    r = int(color[1:3], 16) / 255
    g = int(color[3:5], 16) / 255
    b = int(color[5:7], 16) / 255
    
    # Crear color más oscuro
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    r2, g2, b2 = colorsys.hls_to_rgb(h, max(0, l - 0.2), s)
    darker = f"#{int(r2*255):02x}{int(g2*255):02x}{int(b2*255):02x}"
    
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <defs>
        <radialGradient id="bg_player{number}" cx="30%" cy="30%" r="70%">
            <stop offset="0%" style="stop-color:{color}"/>
            <stop offset="100%" style="stop-color:{darker}"/>
        </radialGradient>
        <linearGradient id="shine_player{number}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:white;stop-opacity:0.4"/>
            <stop offset="40%" style="stop-color:white;stop-opacity:0"/>
        </linearGradient>
        <filter id="shadow_player{number}" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="2" dy="3" stdDeviation="4" flood-opacity="0.4"/>
        </filter>
    </defs>
    
    <!-- Sombra -->
    <circle cx="64" cy="67" r="54" fill="rgba(0,0,0,0.3)"/>
    
    <!-- Fondo -->
    <circle cx="64" cy="64" r="56" fill="url(#bg_player{number})" filter="url(#shadow_player{number})"/>
    
    <!-- Bordes -->
    <circle cx="64" cy="64" r="56" fill="none" stroke="#ffd700" stroke-width="4"/>
    <circle cx="64" cy="64" r="50" fill="none" stroke="#ffd700" stroke-width="1.5" opacity="0.4"/>
    
    <!-- Brillo -->
    <ellipse cx="48" cy="48" rx="30" ry="25" fill="url(#shine_player{number})"/>
    
    <!-- Número -->
    <text x="64" y="78" font-family="Arial Black, sans-serif" font-size="55" font-weight="bold"
          text-anchor="middle" fill="white" filter="url(#shadow_player{number})">{number}</text>
    
    <!-- Player label -->
    <text x="64" y="105" font-family="Arial, sans-serif" font-size="10"
          text-anchor="middle" fill="rgba(255,255,255,0.8)">PLAYER</text>
</svg>'''


# Datos de tokens
DND_TOKENS = [
    # Clases
    ("barbarian", "Barbarian", "barbarian", {"primary": "#8B0000", "secondary": "#4A0000", "accent": "#CD853F"}),
    ("bard", "Bard", "bard", {"primary": "#9932CC", "secondary": "#4B0082", "accent": "#FFD700"}),
    ("cleric", "Cleric", "cleric", {"primary": "#FFD700", "secondary": "#B8860B", "accent": "#FFFFFF"}),
    ("druid", "Druid", "druid", {"primary": "#228B22", "secondary": "#006400", "accent": "#8FBC8F"}),
    ("fighter", "Fighter", "fighter", {"primary": "#708090", "secondary": "#2F4F4F", "accent": "#C0C0C0"}),
    ("monk", "Monk", "monk", {"primary": "#DAA520", "secondary": "#8B4513", "accent": "#FFE4B5"}),
    ("paladin", "Paladin", "paladin", {"primary": "#4169E1", "secondary": "#000080", "accent": "#FFD700"}),
    ("ranger", "Ranger", "ranger", {"primary": "#2E8B57", "secondary": "#006400", "accent": "#8FBC8F"}),
    ("rogue", "Rogue", "rogue", {"primary": "#2F2F2F", "secondary": "#1A1A1A", "accent": "#696969"}),
    ("sorcerer", "Sorcerer", "sorcerer", {"primary": "#FF4500", "secondary": "#8B0000", "accent": "#FF6347"}),
    ("warlock", "Warlock", "warlock", {"primary": "#4B0082", "secondary": "#2F0040", "accent": "#9400D3"}),
    ("wizard", "Wizard", "wizard", {"primary": "#1E90FF", "secondary": "#00008B", "accent": "#87CEEB"}),
    # Razas
    ("dwarf", "Dwarf", "dwarf", {"primary": "#8B4513", "secondary": "#654321", "accent": "#CD853F"}),
    ("elf", "Elf", "elf", {"primary": "#00CED1", "secondary": "#008B8B", "accent": "#E0FFFF"}),
    ("human", "Human", "human", {"primary": "#D2691E", "secondary": "#8B4513", "accent": "#DEB887"}),
    ("halfling", "Halfling", "halfling", {"primary": "#32CD32", "secondary": "#228B22", "accent": "#98FB98"}),
    ("dragonborn", "Dragonborn", "dragonborn", {"primary": "#B22222", "secondary": "#8B0000", "accent": "#FF6347"}),
    ("tiefling", "Tiefling", "tiefling", {"primary": "#8B008B", "secondary": "#4B0082", "accent": "#DA70D6"}),
    # Monstruos
    ("goblin", "Goblin", "goblin", {"primary": "#556B2F", "secondary": "#2F4F2F", "accent": "#6B8E23"}),
    ("orc", "Orc", "orc", {"primary": "#3CB371", "secondary": "#2E8B57", "accent": "#90EE90"}),
    ("skeleton", "Skeleton", "skeleton", {"primary": "#696969", "secondary": "#2F2F2F", "accent": "#D3D3D3"}),
    ("zombie", "Zombie", "zombie", {"primary": "#4A5D23", "secondary": "#2F4F2F", "accent": "#6B8E23"}),
]

BATTLETECH_TOKENS = [
    # Light
    ("locust", "Locust", 20, {"primary": "#4CAF50", "secondary": "#2E7D32", "accent": "#81C784"}),
    ("commando", "Commando", 25, {"primary": "#66BB6A", "secondary": "#388E3C", "accent": "#A5D6A7"}),
    ("jenner", "Jenner", 35, {"primary": "#43A047", "secondary": "#2E7D32", "accent": "#81C784"}),
    ("panther", "Panther", 35, {"primary": "#388E3C", "secondary": "#1B5E20", "accent": "#66BB6A"}),
    ("firestarter", "Firestarter", 35, {"primary": "#FF5722", "secondary": "#E64A19", "accent": "#FF8A65"}),
    # Medium
    ("cicada", "Cicada", 40, {"primary": "#2196F3", "secondary": "#1976D2", "accent": "#64B5F6"}),
    ("hunchback", "Hunchback", 50, {"primary": "#1E88E5", "secondary": "#1565C0", "accent": "#42A5F5"}),
    ("centurion", "Centurion", 50, {"primary": "#1976D2", "secondary": "#0D47A1", "accent": "#2196F3"}),
    ("wolverine", "Wolverine", 55, {"primary": "#0D47A1", "secondary": "#0D47A1", "accent": "#1565C0"}),
    ("shadowhawk", "Shadowhawk", 55, {"primary": "#1565C0", "secondary": "#0D47A1", "accent": "#1976D2"}),
    # Heavy
    ("dragon", "Dragon", 60, {"primary": "#FF9800", "secondary": "#F57C00", "accent": "#FFB74D"}),
    ("quickdraw", "Quickdraw", 60, {"primary": "#FB8C00", "secondary": "#EF6C00", "accent": "#FFA726"}),
    ("catapult", "Catapult", 65, {"primary": "#F57C00", "secondary": "#E65100", "accent": "#FF9800"}),
    ("thunderbolt", "Thunderbolt", 65, {"primary": "#EF6C00", "secondary": "#E65100", "accent": "#FB8C00"}),
    ("grasshopper", "Grasshopper", 70, {"primary": "#E65100", "secondary": "#BF360C", "accent": "#F57C00"}),
    ("warhammer", "Warhammer", 70, {"primary": "#FF5722", "secondary": "#E64A19", "accent": "#FF7043"}),
    ("marauder", "Marauder", 75, {"primary": "#E64A19", "secondary": "#BF360C", "accent": "#FF5722"}),
    ("archer", "Archer", 70, {"primary": "#BF360C", "secondary": "#BF360C", "accent": "#E64A19"}),
    # Assault
    ("awesome", "Awesome", 80, {"primary": "#f44336", "secondary": "#D32F2F", "accent": "#EF5350"}),
    ("zeus", "Zeus", 80, {"primary": "#E53935", "secondary": "#C62828", "accent": "#EF5350"}),
    ("battlemaster", "Battlemaster", 85, {"primary": "#D32F2F", "secondary": "#B71C1C", "accent": "#E53935"}),
    ("stalker", "Stalker", 85, {"primary": "#C62828", "secondary": "#B71C1C", "accent": "#D32F2F"}),
    ("banshee", "Banshee", 95, {"primary": "#B71C1C", "secondary": "#B71C1C", "accent": "#C62828"}),
    ("atlas", "Atlas", 100, {"primary": "#8B0000", "secondary": "#5D0000", "accent": "#B71C1C"}),
    ("king_crab", "King Crab", 100, {"primary": "#A00000", "secondary": "#6B0000", "accent": "#C62828"}),
]

PLAYER_COLORS = [
    "#E53935", "#1E88E5", "#43A047", "#FB8C00", "#8E24AA",
    "#00ACC1", "#FFB300", "#6D4C41", "#546E7A", "#D81B60",
]


def main():
    base_dir = Path(__file__).parent.parent
    markers_dir = base_dir / "assets" / "markers"
    
    dnd_dir = markers_dir / "dnd"
    bt_dir = markers_dir / "battletech"
    generic_dir = markers_dir / "generic"
    
    for d in [dnd_dir, bt_dir, generic_dir]:
        d.mkdir(parents=True, exist_ok=True)
    
    print("🎲 Generando tokens de ALTA CALIDAD para MesaRPG...")
    print()
    
    # D&D
    print("⚔️ Generando tokens de D&D (detallados)...")
    for token_id, name, class_type, colors in DND_TOKENS:
        svg = generate_dnd_token_svg(token_id, name, class_type, colors)
        (dnd_dir / f"{token_id}.svg").write_text(svg, encoding='utf-8')
        print(f"   ✅ {name}")
    
    print()
    
    # BattleTech
    print("🤖 Generando tokens de BattleTech (con siluetas)...")
    for token_id, name, tonnage, colors in BATTLETECH_TOKENS:
        svg = generate_battletech_token_svg(token_id, name, tonnage, colors)
        (bt_dir / f"{token_id}.svg").write_text(svg, encoding='utf-8')
        print(f"   ✅ {name} ({tonnage}T)")
    
    print()
    
    # Genéricos
    print("🎯 Generando tokens genéricos (mejorados)...")
    for i, color in enumerate(PLAYER_COLORS, 1):
        svg = generate_generic_token_svg(i, color)
        (generic_dir / f"player{i}.svg").write_text(svg, encoding='utf-8')
        print(f"   ✅ Player {i}")
    
    # Índice JSON
    token_index = {
        "dnd": [{"id": t[0], "name": t[1], "icon": "⚔️", "file": f"dnd/{t[0]}.svg"} for t in DND_TOKENS],
        "battletech": [{"id": t[0], "name": t[1], "tonnage": t[2], "icon": "🤖", "file": f"battletech/{t[0]}.svg"} for t in BATTLETECH_TOKENS],
        "generic": [{"id": f"player{i}", "name": f"Player {i}", "number": i, "file": f"generic/player{i}.svg"} for i in range(1, len(PLAYER_COLORS) + 1)]
    }
    
    (markers_dir / "tokens.json").write_text(json.dumps(token_index, indent=2), encoding='utf-8')
    
    print()
    print("✨ ¡Tokens de alta calidad generados!")


if __name__ == "__main__":
    main()
