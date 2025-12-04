#!/usr/bin/env python3
"""
Generador de tokens BattleTech - Mechs Ligeros (20-35T)
Diseños coloridos con efectos 3D y detalles realistas
"""

import os

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "assets", "markers", "battletech")

def create_locust():
    """Locust LCT-1V - 20T - Mech explorador ultra rápido"""
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <!-- Gradiente metálico verde militar -->
    <linearGradient id="locustBody" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4a7c59"/>
      <stop offset="30%" style="stop-color:#2d5a3d"/>
      <stop offset="70%" style="stop-color:#1a3d28"/>
      <stop offset="100%" style="stop-color:#0d1f14"/>
    </linearGradient>
    <!-- Efecto metálico brillante -->
    <linearGradient id="locustHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#8fbc8f;stop-opacity:0.8"/>
      <stop offset="50%" style="stop-color:#4a7c59;stop-opacity:0.3"/>
      <stop offset="100%" style="stop-color:#1a3d28;stop-opacity:0"/>
    </linearGradient>
    <!-- Brillo cockpit -->
    <radialGradient id="locustCockpit" cx="50%" cy="30%" r="50%">
      <stop offset="0%" style="stop-color:#00ffff"/>
      <stop offset="40%" style="stop-color:#0088aa"/>
      <stop offset="100%" style="stop-color:#004455"/>
    </radialGradient>
    <!-- Propulsores -->
    <radialGradient id="thruster" cx="50%" cy="50%" r="50%">
      <stop offset="0%" style="stop-color:#ffff00"/>
      <stop offset="40%" style="stop-color:#ff6600"/>
      <stop offset="100%" style="stop-color:#cc0000"/>
    </radialGradient>
    <!-- Sombra -->
    <filter id="shadow3d" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="2" dy="3" stdDeviation="2" flood-opacity="0.5"/>
    </filter>
  </defs>
  
  <!-- Fondo circular con borde metálico -->
  <circle cx="50" cy="50" r="48" fill="#1a1a2e" stroke="#3d5a80" stroke-width="3"/>
  <circle cx="50" cy="50" r="45" fill="none" stroke="url(#locustHighlight)" stroke-width="1"/>
  
  <!-- Cuerpo del mech - torso delgado y aerodinámico -->
  <g filter="url(#shadow3d)">
    <!-- Piernas traseras (en perspectiva) -->
    <path d="M35 75 L30 58 L33 55 L38 70 Z" fill="url(#locustBody)" stroke="#1a3d28" stroke-width="0.5"/>
    <path d="M65 75 L70 58 L67 55 L62 70 Z" fill="url(#locustBody)" stroke="#1a3d28" stroke-width="0.5"/>
    
    <!-- Piernas delanteras -->
    <path d="M38 72 L35 55 L40 48 L45 65 Z" fill="url(#locustBody)" stroke="#1a3d28" stroke-width="0.5"/>
    <ellipse cx="36" cy="75" rx="4" ry="2" fill="#2d5a3d"/>
    <path d="M62 72 L65 55 L60 48 L55 65 Z" fill="url(#locustBody)" stroke="#1a3d28" stroke-width="0.5"/>
    <ellipse cx="64" cy="75" rx="4" ry="2" fill="#2d5a3d"/>
    
    <!-- Torso central - aerodinámico -->
    <ellipse cx="50" cy="45" rx="18" ry="12" fill="url(#locustBody)"/>
    <ellipse cx="50" cy="43" rx="16" ry="8" fill="url(#locustHighlight)" opacity="0.5"/>
    
    <!-- Cabeza/Cockpit -->
    <ellipse cx="50" cy="32" rx="8" ry="6" fill="url(#locustBody)"/>
    <ellipse cx="50" cy="31" rx="5" ry="3" fill="url(#locustCockpit)"/>
    <!-- Reflejo cockpit -->
    <ellipse cx="48" cy="30" rx="2" ry="1" fill="white" opacity="0.6"/>
    
    <!-- Láser medio en torso -->
    <rect x="40" y="40" width="3" height="8" rx="1" fill="#444" stroke="#666" stroke-width="0.3"/>
    <rect x="57" y="40" width="3" height="8" rx="1" fill="#444" stroke="#666" stroke-width="0.3"/>
    <!-- Bocas de láser -->
    <circle cx="41.5" cy="48" r="1" fill="#ff3333"/>
    <circle cx="58.5" cy="48" r="1" fill="#ff3333"/>
    
    <!-- Ametralladoras -->
    <rect x="46" y="52" width="2" height="5" fill="#333"/>
    <rect x="52" y="52" width="2" height="5" fill="#333"/>
    
    <!-- Propulsores de salto (encendidos) -->
    <ellipse cx="42" cy="58" rx="3" ry="2" fill="url(#thruster)"/>
    <ellipse cx="58" cy="58" rx="3" ry="2" fill="url(#thruster)"/>
    <!-- Estela de propulsores -->
    <path d="M42 60 L40 68 L42 66 L44 68 Z" fill="#ff6600" opacity="0.6"/>
    <path d="M58 60 L56 68 L58 66 L60 68 Z" fill="#ff6600" opacity="0.6"/>
  </g>
  
  <!-- Indicador de peso -->
  <rect x="5" y="82" width="28" height="12" rx="3" fill="#2d5a3d" stroke="#4a7c59" stroke-width="1"/>
  <text x="19" y="91" font-family="Arial Black" font-size="8" fill="#8fbc8f" text-anchor="middle">20T</text>
  
  <!-- Nombre -->
  <text x="50" y="95" font-family="Arial Black" font-size="7" fill="#8fbc8f" text-anchor="middle">LOCUST</text>
</svg>'''

def create_commando():
    """Commando COM-2D - 25T - Mech de asalto rápido"""
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="cmdBody" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#8b0000"/>
      <stop offset="30%" style="stop-color:#660000"/>
      <stop offset="70%" style="stop-color:#440000"/>
      <stop offset="100%" style="stop-color:#220000"/>
    </linearGradient>
    <linearGradient id="cmdHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#ff6666;stop-opacity:0.7"/>
      <stop offset="100%" style="stop-color:#8b0000;stop-opacity:0"/>
    </linearGradient>
    <radialGradient id="cmdCockpit" cx="50%" cy="30%" r="50%">
      <stop offset="0%" style="stop-color:#ffff00"/>
      <stop offset="50%" style="stop-color:#ff8800"/>
      <stop offset="100%" style="stop-color:#884400"/>
    </radialGradient>
    <radialGradient id="srmFlare" cx="50%" cy="50%" r="50%">
      <stop offset="0%" style="stop-color:#ffffff"/>
      <stop offset="30%" style="stop-color:#ffcc00"/>
      <stop offset="100%" style="stop-color:#ff3300"/>
    </radialGradient>
    <filter id="cmdShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="2" dy="3" stdDeviation="2" flood-opacity="0.6"/>
    </filter>
  </defs>
  
  <circle cx="50" cy="50" r="48" fill="#1a1a2e" stroke="#8b0000" stroke-width="3"/>
  <circle cx="50" cy="50" r="45" fill="none" stroke="url(#cmdHighlight)" stroke-width="1"/>
  
  <g filter="url(#cmdShadow)">
    <!-- Piernas robustas -->
    <path d="M38 75 L32 55 L38 45 L44 55 L42 75 Z" fill="url(#cmdBody)" stroke="#440000" stroke-width="0.5"/>
    <path d="M62 75 L68 55 L62 45 L56 55 L58 75 Z" fill="url(#cmdBody)" stroke="#440000" stroke-width="0.5"/>
    <!-- Pies -->
    <ellipse cx="40" cy="77" rx="6" ry="3" fill="#660000"/>
    <ellipse cx="60" cy="77" rx="6" ry="3" fill="#660000"/>
    
    <!-- Torso compacto pero fuerte -->
    <path d="M35 50 L40 35 L60 35 L65 50 L60 58 L40 58 Z" fill="url(#cmdBody)"/>
    <path d="M38 48 L42 38 L58 38 L62 48 Z" fill="url(#cmdHighlight)" opacity="0.4"/>
    
    <!-- Lanzador SRM en hombro derecho -->
    <rect x="62" y="32" width="12" height="16" rx="2" fill="#444" stroke="#666" stroke-width="0.5"/>
    <!-- Tubos de misiles (2x3) -->
    <circle cx="66" cy="36" r="2" fill="#222"/>
    <circle cx="70" cy="36" r="2" fill="#222"/>
    <circle cx="66" cy="41" r="2" fill="#222"/>
    <circle cx="70" cy="41" r="2" fill="#222"/>
    <circle cx="66" cy="46" r="2" fill="#222"/>
    <circle cx="70" cy="46" r="2" fill="#222"/>
    <!-- Misil saliendo -->
    <ellipse cx="68" cy="33" rx="1.5" ry="3" fill="url(#srmFlare)"/>
    
    <!-- Brazo izquierdo con láser medio -->
    <path d="M26 38 L35 40 L35 52 L26 54 Z" fill="url(#cmdBody)"/>
    <rect x="20" y="42" width="8" height="4" rx="1" fill="#333"/>
    <circle cx="20" cy="44" r="1.5" fill="#00ff00"/>
    
    <!-- Cabeza angular -->
    <path d="M44 32 L50 24 L56 32 L54 36 L46 36 Z" fill="url(#cmdBody)"/>
    <ellipse cx="50" cy="30" rx="4" ry="3" fill="url(#cmdCockpit)"/>
    <ellipse cx="48" cy="29" rx="1.5" ry="1" fill="white" opacity="0.5"/>
    
    <!-- Láser medio frontal -->
    <rect x="48" y="50" width="4" height="8" fill="#333"/>
    <circle cx="50" cy="58" r="1.5" fill="#ff0000"/>
  </g>
  
  <rect x="5" y="82" width="28" height="12" rx="3" fill="#660000" stroke="#8b0000" stroke-width="1"/>
  <text x="19" y="91" font-family="Arial Black" font-size="8" fill="#ff6666" text-anchor="middle">25T</text>
  
  <text x="50" y="95" font-family="Arial Black" font-size="6" fill="#ff6666" text-anchor="middle">COMMANDO</text>
</svg>'''

def create_jenner():
    """Jenner JR7-D - 35T - Mech de ataque rápido con salto"""
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="jenBody" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#4169e1"/>
      <stop offset="30%" style="stop-color:#2a4494"/>
      <stop offset="70%" style="stop-color:#1a2d66"/>
      <stop offset="100%" style="stop-color:#0d1633"/>
    </linearGradient>
    <linearGradient id="jenHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#87ceeb;stop-opacity:0.8"/>
      <stop offset="100%" style="stop-color:#4169e1;stop-opacity:0"/>
    </linearGradient>
    <radialGradient id="jenCockpit" cx="50%" cy="30%" r="50%">
      <stop offset="0%" style="stop-color:#00ffff"/>
      <stop offset="50%" style="stop-color:#0088cc"/>
      <stop offset="100%" style="stop-color:#004466"/>
    </radialGradient>
    <linearGradient id="laserBeam" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#ff0000"/>
      <stop offset="50%" style="stop-color:#ffff00"/>
      <stop offset="100%" style="stop-color:#ff0000;stop-opacity:0"/>
    </linearGradient>
    <filter id="jenShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="2" dy="3" stdDeviation="2" flood-opacity="0.5"/>
    </filter>
    <filter id="glow">
      <feGaussianBlur stdDeviation="1.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  
  <circle cx="50" cy="50" r="48" fill="#0d1633" stroke="#4169e1" stroke-width="3"/>
  <circle cx="50" cy="50" r="45" fill="none" stroke="url(#jenHighlight)" stroke-width="1.5"/>
  
  <g filter="url(#jenShadow)">
    <!-- Piernas esbeltas de velocista -->
    <path d="M40 78 L34 58 L38 42 L44 42 L46 58 L44 78 Z" fill="url(#jenBody)" stroke="#1a2d66" stroke-width="0.5"/>
    <path d="M60 78 L66 58 L62 42 L56 42 L54 58 L56 78 Z" fill="url(#jenBody)" stroke="#1a2d66" stroke-width="0.5"/>
    <!-- Pies con propulsores -->
    <ellipse cx="42" cy="80" rx="5" ry="2.5" fill="#2a4494"/>
    <ellipse cx="58" cy="80" rx="5" ry="2.5" fill="#2a4494"/>
    <!-- Llamas de salto -->
    <ellipse cx="42" cy="82" rx="3" ry="4" fill="#ff6600" opacity="0.7"/>
    <ellipse cx="58" cy="82" rx="3" ry="4" fill="#ff6600" opacity="0.7"/>
    
    <!-- Torso aerodinámico -->
    <path d="M36 45 L42 28 L58 28 L64 45 L60 55 L40 55 Z" fill="url(#jenBody)"/>
    <path d="M40 42 L45 32 L55 32 L60 42 Z" fill="url(#jenHighlight)" opacity="0.5"/>
    
    <!-- Brazos con láseres medianos (4 en total) -->
    <!-- Brazo izquierdo -->
    <path d="M28 32 L36 34 L36 48 L28 50 Z" fill="url(#jenBody)"/>
    <rect x="18" y="36" width="12" height="3" fill="#333"/>
    <rect x="18" y="42" width="12" height="3" fill="#333"/>
    <!-- Disparos láser -->
    <line x1="18" y1="37.5" x2="5" y2="35" stroke="url(#laserBeam)" stroke-width="2" filter="url(#glow)"/>
    
    <!-- Brazo derecho -->
    <path d="M72 32 L64 34 L64 48 L72 50 Z" fill="url(#jenBody)"/>
    <rect x="70" y="36" width="12" height="3" fill="#333"/>
    <rect x="70" y="42" width="12" height="3" fill="#333"/>
    <!-- Disparos láser -->
    <line x1="82" y1="37.5" x2="95" y2="35" stroke="url(#laserBeam)" stroke-width="2" filter="url(#glow)"/>
    
    <!-- Cabeza estilizada -->
    <path d="M44 30 L50 20 L56 30 L54 34 L46 34 Z" fill="url(#jenBody)"/>
    <ellipse cx="50" cy="26" rx="4" ry="3" fill="url(#jenCockpit)"/>
    <ellipse cx="48" cy="25" rx="1.5" ry="1" fill="white" opacity="0.6"/>
    
    <!-- SRM-4 en torso -->
    <rect x="44" y="48" width="12" height="6" rx="1" fill="#333"/>
    <circle cx="47" cy="51" r="1.5" fill="#222"/>
    <circle cx="53" cy="51" r="1.5" fill="#222"/>
  </g>
  
  <rect x="5" y="82" width="28" height="12" rx="3" fill="#2a4494" stroke="#4169e1" stroke-width="1"/>
  <text x="19" y="91" font-family="Arial Black" font-size="8" fill="#87ceeb" text-anchor="middle">35T</text>
  
  <text x="50" y="95" font-family="Arial Black" font-size="7" fill="#87ceeb" text-anchor="middle">JENNER</text>
</svg>'''

def create_panther():
    """Panther PNT-9R - 35T - Francotirador ligero"""
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="pntBody" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#2f4f4f"/>
      <stop offset="30%" style="stop-color:#1a3333"/>
      <stop offset="70%" style="stop-color:#0d1a1a"/>
      <stop offset="100%" style="stop-color:#050d0d"/>
    </linearGradient>
    <linearGradient id="pntHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#5f9f9f;stop-opacity:0.7"/>
      <stop offset="100%" style="stop-color:#2f4f4f;stop-opacity:0"/>
    </linearGradient>
    <radialGradient id="ppcCharge" cx="50%" cy="50%" r="50%">
      <stop offset="0%" style="stop-color:#ffffff"/>
      <stop offset="20%" style="stop-color:#00ffff"/>
      <stop offset="50%" style="stop-color:#0088ff"/>
      <stop offset="100%" style="stop-color:#0044aa"/>
    </radialGradient>
    <filter id="pntShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="2" dy="3" stdDeviation="2" flood-opacity="0.5"/>
    </filter>
    <filter id="electricGlow">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  
  <circle cx="50" cy="50" r="48" fill="#0a1515" stroke="#2f4f4f" stroke-width="3"/>
  <circle cx="50" cy="50" r="45" fill="none" stroke="url(#pntHighlight)" stroke-width="1"/>
  
  <g filter="url(#pntShadow)">
    <!-- Piernas -->
    <path d="M38 78 L33 55 L38 40 L45 40 L47 55 L44 78 Z" fill="url(#pntBody)"/>
    <path d="M62 78 L67 55 L62 40 L55 40 L53 55 L56 78 Z" fill="url(#pntBody)"/>
    <ellipse cx="41" cy="80" rx="5" ry="2" fill="#1a3333"/>
    <ellipse cx="59" cy="80" rx="5" ry="2" fill="#1a3333"/>
    
    <!-- Torso angular tipo ninja -->
    <path d="M35 45 L40 28 L60 28 L65 45 L62 58 L38 58 Z" fill="url(#pntBody)"/>
    <path d="M38 42 L43 32 L57 32 L62 42 Z" fill="url(#pntHighlight)" opacity="0.4"/>
    
    <!-- PPC en brazo derecho - ARMA PRINCIPAL -->
    <path d="M64 30 L72 32 L74 50 L64 52 Z" fill="url(#pntBody)"/>
    <!-- Cañón PPC grande -->
    <rect x="70" y="28" width="18" height="10" rx="2" fill="#333" stroke="#444" stroke-width="0.5"/>
    <rect x="72" y="30" width="14" height="6" rx="1" fill="#222"/>
    <!-- Carga eléctrica del PPC -->
    <circle cx="88" cy="33" r="5" fill="url(#ppcCharge)" filter="url(#electricGlow)"/>
    <!-- Rayos eléctricos -->
    <path d="M86 30 L90 33 L86 36 L92 33 Z" fill="#00ffff" opacity="0.8"/>
    
    <!-- Brazo izquierdo con SRM-4 -->
    <path d="M36 30 L28 32 L26 50 L36 52 Z" fill="url(#pntBody)"/>
    <rect x="20" y="35" width="10" height="8" rx="1" fill="#333"/>
    <circle cx="23" cy="38" r="1.5" fill="#222"/>
    <circle cx="27" cy="38" r="1.5" fill="#222"/>
    <circle cx="23" cy="42" r="1.5" fill="#222"/>
    <circle cx="27" cy="42" r="1.5" fill="#222"/>
    
    <!-- Cabeza sigilosa -->
    <path d="M44 30 L50 18 L56 30 L54 35 L46 35 Z" fill="url(#pntBody)"/>
    <ellipse cx="50" cy="25" rx="4" ry="3" fill="#003344"/>
    <ellipse cx="50" cy="24" rx="3" ry="2" fill="#00aacc" opacity="0.8"/>
    <ellipse cx="48" cy="23" rx="1" ry="0.7" fill="white" opacity="0.5"/>
  </g>
  
  <rect x="5" y="82" width="28" height="12" rx="3" fill="#1a3333" stroke="#2f4f4f" stroke-width="1"/>
  <text x="19" y="91" font-family="Arial Black" font-size="8" fill="#5f9f9f" text-anchor="middle">35T</text>
  
  <text x="50" y="95" font-family="Arial Black" font-size="6" fill="#5f9f9f" text-anchor="middle">PANTHER</text>
</svg>'''

def create_firestarter():
    """Firestarter FS9-H - 35T - Incendiario"""
    return '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="fsBody" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#ff4500"/>
      <stop offset="30%" style="stop-color:#cc3300"/>
      <stop offset="70%" style="stop-color:#882200"/>
      <stop offset="100%" style="stop-color:#441100"/>
    </linearGradient>
    <linearGradient id="fsHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#ffaa00;stop-opacity:0.8"/>
      <stop offset="100%" style="stop-color:#ff4500;stop-opacity:0"/>
    </linearGradient>
    <radialGradient id="flame" cx="50%" cy="100%" r="80%">
      <stop offset="0%" style="stop-color:#ffffff"/>
      <stop offset="20%" style="stop-color:#ffff00"/>
      <stop offset="50%" style="stop-color:#ff6600"/>
      <stop offset="100%" style="stop-color:#cc0000;stop-opacity:0"/>
    </radialGradient>
    <filter id="fsShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="2" dy="3" stdDeviation="2" flood-opacity="0.5"/>
    </filter>
    <filter id="flameGlow">
      <feGaussianBlur stdDeviation="1.5"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  
  <circle cx="50" cy="50" r="48" fill="#220000" stroke="#ff4500" stroke-width="3"/>
  <circle cx="50" cy="50" r="45" fill="none" stroke="url(#fsHighlight)" stroke-width="1.5"/>
  
  <g filter="url(#fsShadow)">
    <!-- Piernas con propulsores -->
    <path d="M38 76 L34 55 L38 42 L45 42 L46 55 L44 76 Z" fill="url(#fsBody)"/>
    <path d="M62 76 L66 55 L62 42 L55 42 L54 55 L56 76 Z" fill="url(#fsBody)"/>
    <ellipse cx="41" cy="78" rx="5" ry="2" fill="#882200"/>
    <ellipse cx="59" cy="78" rx="5" ry="2" fill="#882200"/>
    
    <!-- Llamas de propulsores -->
    <ellipse cx="41" cy="82" rx="4" ry="6" fill="url(#flame)" filter="url(#flameGlow)"/>
    <ellipse cx="59" cy="82" rx="4" ry="6" fill="url(#flame)" filter="url(#flameGlow)"/>
    
    <!-- Torso -->
    <path d="M36 48 L40 32 L60 32 L64 48 L60 58 L40 58 Z" fill="url(#fsBody)"/>
    <path d="M40 45 L44 36 L56 36 L60 45 Z" fill="url(#fsHighlight)" opacity="0.5"/>
    
    <!-- Lanzallamas en ambos brazos -->
    <!-- Brazo izquierdo -->
    <path d="M28 34 L36 36 L36 50 L28 52 Z" fill="url(#fsBody)"/>
    <rect x="16" y="38" width="14" height="6" rx="2" fill="#444"/>
    <!-- Llama saliendo -->
    <ellipse cx="10" cy="41" rx="8" ry="4" fill="url(#flame)" filter="url(#flameGlow)"/>
    
    <!-- Brazo derecho -->
    <path d="M72 34 L64 36 L64 50 L72 52 Z" fill="url(#fsBody)"/>
    <rect x="70" y="38" width="14" height="6" rx="2" fill="#444"/>
    <!-- Llama saliendo -->
    <ellipse cx="90" cy="41" rx="8" ry="4" fill="url(#flame)" filter="url(#flameGlow)"/>
    
    <!-- Láseres medianos en torso -->
    <rect x="44" y="50" width="4" height="8" fill="#333"/>
    <rect x="52" y="50" width="4" height="8" fill="#333"/>
    <circle cx="46" cy="58" r="1.5" fill="#ff0000"/>
    <circle cx="54" cy="58" r="1.5" fill="#ff0000"/>
    
    <!-- Cabeza con visor naranja -->
    <path d="M44 34 L50 24 L56 34 L54 38 L46 38 Z" fill="url(#fsBody)"/>
    <ellipse cx="50" cy="30" rx="4" ry="3" fill="#ff8800"/>
    <ellipse cx="50" cy="29" rx="3" ry="2" fill="#ffcc00" opacity="0.8"/>
    <ellipse cx="48" cy="28" rx="1" ry="0.7" fill="white" opacity="0.5"/>
    
    <!-- Tanques de combustible en espalda -->
    <ellipse cx="45" cy="45" rx="4" ry="8" fill="#666" stroke="#444" stroke-width="0.5"/>
    <ellipse cx="55" cy="45" rx="4" ry="8" fill="#666" stroke="#444" stroke-width="0.5"/>
    <text x="45" y="47" font-size="4" fill="#ff6600" text-anchor="middle">⚠</text>
    <text x="55" y="47" font-size="4" fill="#ff6600" text-anchor="middle">⚠</text>
  </g>
  
  <rect x="5" y="82" width="28" height="12" rx="3" fill="#882200" stroke="#ff4500" stroke-width="1"/>
  <text x="19" y="91" font-family="Arial Black" font-size="8" fill="#ffaa00" text-anchor="middle">35T</text>
  
  <text x="50" y="95" font-family="Arial Black" font-size="5" fill="#ffaa00" text-anchor="middle">FIRESTARTER</text>
</svg>'''

def generate_light_mechs():
    """Genera todos los mechs ligeros"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    mechs = [
        ("locust", create_locust),
        ("commando", create_commando),
        ("jenner", create_jenner),
        ("panther", create_panther),
        ("firestarter", create_firestarter),
    ]
    
    print("🤖 Generando Mechs Ligeros (20-35T)...")
    for name, generator in mechs:
        filepath = os.path.join(OUTPUT_DIR, f"{name}.svg")
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(generator())
        print(f"   ✅ {name.capitalize()}")
    
    print(f"\n✨ {len(mechs)} mechs ligeros generados en {OUTPUT_DIR}")

if __name__ == "__main__":
    generate_light_mechs()
