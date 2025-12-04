import asyncio
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from server.game_state import GameStateManager


async def main():
    config_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'config'))
    print('Using config dir:', config_dir)
    gsm = GameStateManager(config_path=config_dir)

    test_map = {
        "name": "test-map",
        "width": 10,
        "height": 8,
        "gridType": "square",
        "cellSize": 32,
        "tiles": [
            {"x": 0, "y": 0, "tileId": "grass"},
            {"x": 1, "y": 0, "tileId": "stone"}
        ],
        "metadata": {"creator": "test"}
    }

    print('Saving map...')
    res = await gsm.save_map(test_map)
    print('save_map result:', res)

    maps = await gsm.get_all_maps()
    print('get_all_maps count:', len(maps))

    mid = res.get('id')
    if not mid:
        print('No id returned from save_map, aborting')
        return

    m = await gsm.get_map(mid)
    print('get_map name:', m.get('name'), 'tiles len:', len(m.get('tiles', [])))

    ok = await gsm.set_current_map(mid)
    print('set_current_map:', ok)

    full = gsm.get_full_state()
    print('current_map in full state id:', (full.get('current_map') or {}).get('id'))

    print('Cleaning up: delete map', mid)
    deleted = await gsm.delete_map(mid)
    print('deleted:', deleted)


if __name__ == '__main__':
    asyncio.run(main())
