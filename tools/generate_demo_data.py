"""
MesaRPG - Generador de Datos de Demo
Crea datos de ejemplo para probar el sistema
"""

import json
from pathlib import Path
import random


def generate_demo_characters():
    """Genera personajes de demostración"""
    
    characters = {
        "characters": [
            {
                "id": "warrior_1",
                "name": "Thorin Ironforge",
                "class": "Guerrero",
                "player": "Jugador 1",
                "marker_id": 1,
                "hp": 45,
                "max_hp": 45,
                "armor": 18,
                "speed": 30,
                "color": "#e74c3c",
                "icon": "⚔️",
                "abilities": [
                    {
                        "id": "strike",
                        "name": "Golpe Poderoso",
                        "description": "Un golpe devastador con el arma",
                        "type": "attack",
                        "damage": "2d6+4",
                        "range": 5,
                        "cooldown": 0
                    },
                    {
                        "id": "cleave",
                        "name": "Tajo Amplio",
                        "description": "Ataca a todos los enemigos adyacentes",
                        "type": "attack",
                        "damage": "1d8+2",
                        "range": 5,
                        "cooldown": 3
                    },
                    {
                        "id": "shield_wall",
                        "name": "Muro de Escudos",
                        "description": "+4 CA hasta el próximo turno",
                        "type": "defense",
                        "cooldown": 4
                    }
                ]
            },
            {
                "id": "mage_1",
                "name": "Elara Starweave",
                "class": "Maga",
                "player": "Jugador 2",
                "marker_id": 2,
                "hp": 28,
                "max_hp": 28,
                "armor": 12,
                "speed": 30,
                "color": "#9b59b6",
                "icon": "🔮",
                "abilities": [
                    {
                        "id": "fireball",
                        "name": "Bola de Fuego",
                        "description": "Explosión de fuego en un área",
                        "type": "attack",
                        "damage": "8d6",
                        "range": 150,
                        "area": 20,
                        "cooldown": 1
                    },
                    {
                        "id": "magic_missile",
                        "name": "Proyectil Mágico",
                        "description": "Tres proyectiles que siempre impactan",
                        "type": "attack",
                        "damage": "3d4+3",
                        "range": 120,
                        "cooldown": 0
                    },
                    {
                        "id": "shield",
                        "name": "Escudo Arcano",
                        "description": "+5 CA como reacción",
                        "type": "defense",
                        "cooldown": 2
                    }
                ]
            },
            {
                "id": "rogue_1",
                "name": "Shadow",
                "class": "Pícaro",
                "player": "Jugador 3",
                "marker_id": 3,
                "hp": 32,
                "max_hp": 32,
                "armor": 14,
                "speed": 40,
                "color": "#1abc9c",
                "icon": "🗡️",
                "abilities": [
                    {
                        "id": "sneak_attack",
                        "name": "Ataque Furtivo",
                        "description": "Daño extra si tienes ventaja",
                        "type": "attack",
                        "damage": "3d6+4",
                        "range": 5,
                        "cooldown": 0
                    },
                    {
                        "id": "hide",
                        "name": "Esconderse",
                        "description": "Te vuelves invisible hasta atacar",
                        "type": "utility",
                        "cooldown": 1
                    },
                    {
                        "id": "evasion",
                        "name": "Evasión",
                        "description": "Evita todo daño de área",
                        "type": "defense",
                        "cooldown": 5
                    }
                ]
            },
            {
                "id": "cleric_1",
                "name": "Father Marcus",
                "class": "Clérigo",
                "player": "Jugador 4",
                "marker_id": 4,
                "hp": 36,
                "max_hp": 36,
                "armor": 16,
                "speed": 30,
                "color": "#f1c40f",
                "icon": "✝️",
                "abilities": [
                    {
                        "id": "heal",
                        "name": "Curar Heridas",
                        "description": "Restaura puntos de vida",
                        "type": "healing",
                        "healing": "2d8+3",
                        "range": 30,
                        "cooldown": 0
                    },
                    {
                        "id": "sacred_flame",
                        "name": "Llama Sagrada",
                        "description": "Fuego divino que abrasa",
                        "type": "attack",
                        "damage": "2d8",
                        "range": 60,
                        "cooldown": 0
                    },
                    {
                        "id": "mass_heal",
                        "name": "Curación Masiva",
                        "description": "Cura a todos los aliados cercanos",
                        "type": "healing",
                        "healing": "3d8+5",
                        "area": 30,
                        "cooldown": 6
                    }
                ]
            }
        ]
    }
    
    return characters


def generate_demo_enemies():
    """Genera enemigos de demostración"""
    
    enemies = {
        "enemies": [
            {
                "id": "goblin_1",
                "name": "Goblin Explorador",
                "type": "Goblin",
                "marker_id": 10,
                "hp": 12,
                "max_hp": 12,
                "armor": 13,
                "color": "#27ae60",
                "icon": "👺"
            },
            {
                "id": "goblin_2",
                "name": "Goblin Guerrero",
                "type": "Goblin",
                "marker_id": 11,
                "hp": 15,
                "max_hp": 15,
                "armor": 14,
                "color": "#27ae60",
                "icon": "👺"
            },
            {
                "id": "orc_1",
                "name": "Orco Berserker",
                "type": "Orco",
                "marker_id": 12,
                "hp": 30,
                "max_hp": 30,
                "armor": 13,
                "color": "#c0392b",
                "icon": "👹"
            },
            {
                "id": "skeleton_1",
                "name": "Esqueleto Guardián",
                "type": "No-muerto",
                "marker_id": 13,
                "hp": 20,
                "max_hp": 20,
                "armor": 13,
                "color": "#bdc3c7",
                "icon": "💀"
            },
            {
                "id": "dragon_1",
                "name": "Dragón Joven Rojo",
                "type": "Dragón",
                "marker_id": 14,
                "hp": 150,
                "max_hp": 150,
                "armor": 18,
                "color": "#e74c3c",
                "icon": "🐉"
            }
        ]
    }
    
    return enemies


def generate_demo_map():
    """Genera configuración de mapa de demostración"""
    
    map_config = {
        "name": "Mazmorra del Dragón",
        "description": "Una antigua mazmorra donde habita un temible dragón",
        "grid_size": 5,
        "background_image": "maps/dungeon_dragon.png",
        "width": 1920,
        "height": 1080,
        "obstacles": [
            {"x": 200, "y": 300, "width": 100, "height": 200, "type": "wall"},
            {"x": 500, "y": 100, "width": 150, "height": 100, "type": "pillar"},
            {"x": 800, "y": 500, "width": 200, "height": 50, "type": "rubble"}
        ],
        "spawn_points": {
            "players": [
                {"x": 100, "y": 900},
                {"x": 200, "y": 900},
                {"x": 300, "y": 900},
                {"x": 400, "y": 900}
            ],
            "enemies": [
                {"x": 1600, "y": 200},
                {"x": 1700, "y": 300},
                {"x": 1500, "y": 400}
            ],
            "boss": {"x": 1700, "y": 150}
        }
    }
    
    return map_config


def main():
    print("=" * 50)
    print("MesaRPG - Generador de Datos Demo")
    print("=" * 50)
    print()
    
    config_dir = Path(__file__).parent.parent / "config"
    
    # Generar personajes
    characters = generate_demo_characters()
    char_file = config_dir / "characters.json"
    with open(char_file, 'w', encoding='utf-8') as f:
        json.dump(characters, f, indent=2, ensure_ascii=False)
    print(f"✅ Personajes generados: {char_file}")
    
    # Generar enemigos
    enemies = generate_demo_enemies()
    enemy_file = config_dir / "enemies.json"
    with open(enemy_file, 'w', encoding='utf-8') as f:
        json.dump(enemies, f, indent=2, ensure_ascii=False)
    print(f"✅ Enemigos generados: {enemy_file}")
    
    # Generar mapa demo
    demo_map = generate_demo_map()
    map_file = config_dir / "demo_map.json"
    with open(map_file, 'w', encoding='utf-8') as f:
        json.dump(demo_map, f, indent=2, ensure_ascii=False)
    print(f"✅ Mapa demo generado: {map_file}")
    
    print()
    print("=" * 50)
    print("✨ Datos de demostración creados!")
    print()
    print("Estos datos te permiten probar el sistema sin")
    print("tener que crear toda la configuración manualmente.")
    print()
    print("Puedes editar los archivos JSON para personalizar")
    print("los personajes, enemigos y mapas.")
    print()


if __name__ == "__main__":
    main()
