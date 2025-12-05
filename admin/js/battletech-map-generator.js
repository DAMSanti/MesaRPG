/**
 * BattleTech Map Generator
 * Genera mapas siguiendo las reglas del juego táctico de miniaturas
 * 
 * Reglas implementadas:
 * - Tiles agrupados (_0, _1, etc.) siempre van juntos
 * - Elevación por hex (0-4)
 * - Coherencia geográfica (transiciones suaves)
 * - Variedad estratégica (cobertura, zonas abiertas, choke-points)
 * - Mapas jugables (caminos, puntos de interés)
 */

class BattleTechMapGenerator {
    constructor(editor) {
        this.editor = editor;
        this.width = 0;
        this.height = 0;
        this.terrainMap = [];      // Tipo de terreno por hex
        this.elevationMap = [];    // Elevación por hex (0-4)
        this.tileAssignments = []; // Tile asignado por hex
        
        // Grupos de tiles (se cargan de config)
        this.tileGroups = null;
        this.loadTileGroups();
    }
    
    async loadTileGroups() {
        try {
            const response = await fetch('/config/battletech_tile_groups.json');
            this.tileGroups = await response.json();
        } catch (e) {
            console.warn('No se pudieron cargar grupos de tiles, usando defaults');
            this.tileGroups = { groups: {}, singles: {} };
        }
    }
    
    /**
     * Genera un mapa completo
     */
    generate(width, height, type = 'grasslands') {
        this.width = width;
        this.height = height;
        
        // Inicializar mapas
        this.terrainMap = this.createEmptyGrid(null);
        this.elevationMap = this.createEmptyGrid(0);
        this.tileAssignments = this.createEmptyGrid(null);
        
        // Generar según tipo
        switch(type) {
            case 'bt_grasslands':
                this.generateGrasslands();
                break;
            case 'bt_forest':
                this.generateForest();
                break;
            case 'bt_city':
                this.generateCity();
                break;
            case 'bt_river':
                this.generateRiver();
                break;
            case 'bt_ruins':
                this.generateRuins();
                break;
            case 'bt_desert':
                this.generateDesert();
                break;
            case 'bt_mountains':
                this.generateMountains();
                break;
            default:
                this.generateGrasslands();
        }
        
        // Convertir a formato del editor
        return this.buildMapData();
    }
    
    createEmptyGrid(defaultValue) {
        const grid = [];
        for (let y = 0; y < this.height; y++) {
            grid[y] = [];
            for (let x = 0; x < this.width; x++) {
                grid[y][x] = defaultValue;
            }
        }
        return grid;
    }
    
    // ==========================================
    // GENERADORES DE MAPAS
    // ==========================================
    
    /**
     * Llanuras: Terreno abierto con colinas suaves y bosques dispersos
     * Ideal para combates de largo alcance
     */
    generateGrasslands() {
        // 1. Base: todo llanura nivel 0
        this.fillTerrain('clear', 0);
        
        // 2. Generar elevación con Perlin-like noise
        this.generateSmoothElevation(0, 2, 0.3);
        
        // 3. Añadir clusters de bosques (15-20% del mapa)
        this.placeTerrainClusters('woods', 0.15, 3, 7);
        
        // 4. Algunos bosques densos en zonas altas
        this.placeTerrainOnElevation('woods_heavy', 2, 0.3);
        
        // 5. Terreno rocoso disperso
        this.scatterTerrain('rough', 0.05);
        
        // 6. Asignar tiles visuales
        this.assignTiles();
    }
    
    /**
     * Bosque: Bosque denso con claros estratégicos
     * Combate cercano, emboscadas
     */
    generateForest() {
        // 1. Base: bosque ligero
        this.fillTerrain('woods', 0);
        
        // 2. Elevación moderada
        this.generateSmoothElevation(0, 2, 0.2);
        
        // 3. Bosque denso en 40% del mapa
        this.placeTerrainClusters('woods_heavy', 0.4, 5, 12);
        
        // 4. Claros (llanura) - importantes para maniobra
        this.placeTerrainClusters('clear', 0.15, 4, 8);
        
        // 5. Un arroyo atravesando
        if (Math.random() < 0.6) {
            this.placeRiver(1); // Profundidad 1
        }
        
        // 6. Rocas dispersas
        this.scatterTerrain('rough', 0.03);
        
        this.assignTiles();
    }
    
    /**
     * Ciudad: Grid urbano con edificios y calles
     * Combate urbano, líneas de fuego cortas
     */
    generateCity() {
        // 1. Base: llanura (calles)
        this.fillTerrain('clear', 0);
        
        // 2. Elevación baja
        this.generateSmoothElevation(0, 1, 0.1);
        
        // 3. Colocar bloques de edificios
        this.placeBuildingBlocks();
        
        // 4. Añadir escombros alrededor de edificios
        this.placeRubbleNearBuildings(0.3);
        
        // 5. Algunos parques (bosques pequeños)
        this.placeTerrainClusters('woods', 0.05, 2, 4);
        
        this.assignTiles();
    }
    
    /**
     * Río: Río atravesando llanuras con bosques ribereños
     * Control del vado/puente es clave
     */
    generateRiver() {
        // 1. Base: llanura
        this.fillTerrain('clear', 0);
        
        // 2. Elevación: más alta lejos del río
        this.generateSmoothElevation(0, 2, 0.25);
        
        // 3. Río principal atravesando el mapa
        this.placeRiver(2); // Profundidad 2
        
        // 4. Posibles vados (depth 0)
        this.placeFordsOnRiver();
        
        // 5. Bosques ribereños (cerca del agua)
        this.placeTerrainNear('water', 'woods', 2, 0.5);
        
        // 6. Colinas lejos del río
        this.increaseElevationAwayFrom('water', 1);
        
        this.assignTiles();
    }
    
    /**
     * Ruinas: Ciudad destruida, escombros y peligros
     * Combate caótico, peligros ambientales
     */
    generateRuins() {
        // 1. Base: mezcla de clear y rubble
        this.fillTerrain('clear', 0);
        
        // 2. Elevación irregular (cráteres y montículos)
        this.generateChaoticElevation(0, 3);
        
        // 3. Escombros abundantes (40%)
        this.placeTerrainClusters('rubble', 0.4, 3, 8);
        
        // 4. Edificios parcialmente destruidos
        this.placeScatteredBuildings(0.15);
        
        // 5. Cráteres (rough con elevación -1)
        this.placeCraters(5);
        
        // 6. Zonas de humo
        this.scatterTerrain('hazards', 0.05);
        
        this.assignTiles();
    }
    
    /**
     * Desierto: Terreno rocoso con poca cobertura
     * Largo alcance, calor es factor
     */
    generateDesert() {
        // 1. Base: clear (arena)
        this.fillTerrain('clear', 0);
        
        // 2. Elevación variable (dunas y mesetas)
        this.generateSmoothElevation(0, 3, 0.4);
        
        // 3. Formaciones rocosas
        this.placeTerrainClusters('rough', 0.25, 3, 8);
        
        // 4. Muy pocos bosques (oasis)
        this.placeTerrainClusters('woods', 0.02, 2, 4);
        
        // 5. Posible pequeña fuente de agua
        if (Math.random() < 0.3) {
            this.placePond();
        }
        
        this.assignTiles();
    }
    
    /**
     * Montañas: Terreno muy elevado con pasos estrechos
     * Choke points, saltos importantes
     */
    generateMountains() {
        // 1. Base: rough (terreno montañoso)
        this.fillTerrain('rough', 1);
        
        // 2. Elevación alta y variada
        this.generateSmoothElevation(1, 4, 0.5);
        
        // 3. Picos (nivel 4)
        this.placeTerrainOnElevation('rough', 4, 0.8);
        
        // 4. Valles (clear nivel 0-1)
        this.carveValleys();
        
        // 5. Bosques en laderas medias
        this.placeTerrainOnElevation('woods', 1, 0.3);
        this.placeTerrainOnElevation('woods', 2, 0.2);
        
        // 6. Posible río en valle
        if (Math.random() < 0.4) {
            this.placeRiverInValley();
        }
        
        this.assignTiles();
    }
    
    // ==========================================
    // UTILIDADES DE GENERACIÓN
    // ==========================================
    
    fillTerrain(type, elevation) {
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                this.terrainMap[y][x] = type;
                this.elevationMap[y][x] = elevation;
            }
        }
    }
    
    generateSmoothElevation(min, max, roughness) {
        // Simplex-like noise para elevación suave
        const scale = 0.15;
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                // Pseudo-noise basado en seno
                const nx = x * scale;
                const ny = y * scale;
                let noise = Math.sin(nx * 2.1 + ny * 1.7) * 0.5 +
                           Math.sin(nx * 4.3 + ny * 3.2) * 0.25 +
                           Math.sin(nx * 8.1 + ny * 7.5) * 0.125;
                noise = (noise + 1) / 2; // Normalizar a 0-1
                
                // Añadir algo de aleatoriedad
                noise += (Math.random() - 0.5) * roughness;
                noise = Math.max(0, Math.min(1, noise));
                
                this.elevationMap[y][x] = Math.floor(min + noise * (max - min + 1));
                this.elevationMap[y][x] = Math.min(max, Math.max(min, this.elevationMap[y][x]));
            }
        }
    }
    
    generateChaoticElevation(min, max) {
        // Más aleatorio, para ruinas
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                this.elevationMap[y][x] = min + Math.floor(Math.random() * (max - min + 1));
            }
        }
    }
    
    placeTerrainClusters(type, coverage, minSize, maxSize) {
        const targetHexes = Math.floor(this.width * this.height * coverage);
        let placed = 0;
        let attempts = 0;
        const maxAttempts = 1000;
        
        while (placed < targetHexes && attempts < maxAttempts) {
            attempts++;
            
            const cx = Math.floor(Math.random() * this.width);
            const cy = Math.floor(Math.random() * this.height);
            const size = minSize + Math.floor(Math.random() * (maxSize - minSize));
            
            // Colocar cluster orgánico
            placed += this.placeOrganicCluster(cx, cy, size, type);
        }
    }
    
    placeOrganicCluster(cx, cy, size, type) {
        let placed = 0;
        const visited = new Set();
        const queue = [{x: cx, y: cy}];
        
        while (queue.length > 0 && placed < size) {
            const {x, y} = queue.shift();
            const key = `${x},${y}`;
            
            if (visited.has(key)) continue;
            if (!this.isValid(x, y)) continue;
            visited.add(key);
            
            // No sobrescribir water o urban
            if (this.terrainMap[y][x] === 'water' || this.terrainMap[y][x] === 'urban') {
                continue;
            }
            
            this.terrainMap[y][x] = type;
            placed++;
            
            // Añadir vecinos con probabilidad decreciente
            const neighbors = this.getHexNeighbors(x, y);
            for (const n of neighbors) {
                if (Math.random() < 0.6) {
                    queue.push(n);
                }
            }
        }
        
        return placed;
    }
    
    scatterTerrain(type, density) {
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (Math.random() < density) {
                    if (this.terrainMap[y][x] === 'clear') {
                        this.terrainMap[y][x] = type;
                    }
                }
            }
        }
    }
    
    placeTerrainOnElevation(type, elevation, probability) {
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.elevationMap[y][x] === elevation && Math.random() < probability) {
                    if (this.terrainMap[y][x] === 'clear' || this.terrainMap[y][x] === 'rough') {
                        this.terrainMap[y][x] = type;
                    }
                }
            }
        }
    }
    
    placeTerrainNear(nearType, placeType, distance, probability) {
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.terrainMap[y][x] === 'clear') {
                    if (this.isNearTerrain(x, y, nearType, distance)) {
                        if (Math.random() < probability) {
                            this.terrainMap[y][x] = placeType;
                        }
                    }
                }
            }
        }
    }
    
    isNearTerrain(x, y, type, distance) {
        for (let dy = -distance; dy <= distance; dy++) {
            for (let dx = -distance; dx <= distance; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (this.isValid(nx, ny) && this.terrainMap[ny][nx] === type) {
                    return true;
                }
            }
        }
        return false;
    }
    
    placeRiver(depth) {
        // Río serpenteante de un borde a otro
        const vertical = Math.random() < 0.5;
        let current = vertical 
            ? { x: Math.floor(this.width / 2) + Math.floor(Math.random() * 4) - 2, y: 0 }
            : { x: 0, y: Math.floor(this.height / 2) + Math.floor(Math.random() * 4) - 2 };
        
        const end = vertical ? this.height : this.width;
        
        for (let i = 0; i < end; i++) {
            // Colocar agua en posición actual y adyacentes
            for (let w = -1; w <= 1; w++) {
                const wx = vertical ? current.x + w : current.x;
                const wy = vertical ? current.y : current.y + w;
                if (this.isValid(wx, wy)) {
                    this.terrainMap[wy][wx] = 'water';
                    this.elevationMap[wy][wx] = 0;
                }
            }
            
            // Avanzar
            if (vertical) {
                current.y++;
                current.x += Math.floor(Math.random() * 3) - 1;
                current.x = Math.max(1, Math.min(this.width - 2, current.x));
            } else {
                current.x++;
                current.y += Math.floor(Math.random() * 3) - 1;
                current.y = Math.max(1, Math.min(this.height - 2, current.y));
            }
        }
    }
    
    placeFordsOnRiver() {
        // Encontrar hexes de agua y convertir algunos a depth 0 (vados)
        let fords = 0;
        const maxFords = 2;
        
        for (let y = 0; y < this.height && fords < maxFords; y++) {
            for (let x = 0; x < this.width && fords < maxFords; x++) {
                if (this.terrainMap[y][x] === 'water' && Math.random() < 0.05) {
                    // Marcar como vado (se representará distinto)
                    this.terrainMap[y][x] = 'water_depth0';
                    fords++;
                }
            }
        }
    }
    
    placeBuildingBlocks() {
        const blockSize = 3;
        const streetWidth = 2;
        
        for (let by = 1; by < this.height - blockSize; by += blockSize + streetWidth) {
            for (let bx = 1; bx < this.width - blockSize; bx += blockSize + streetWidth) {
                // 70% de probabilidad de edificio
                if (Math.random() < 0.7) {
                    this.placeBuilding(bx, by, blockSize);
                }
            }
        }
    }
    
    placeBuilding(x, y, size) {
        // Colocar un edificio (puede ser de varios tamaños)
        const actualSize = Math.min(size, 1 + Math.floor(Math.random() * 3));
        
        for (let dy = 0; dy < actualSize; dy++) {
            for (let dx = 0; dx < actualSize; dx++) {
                if (this.isValid(x + dx, y + dy)) {
                    this.terrainMap[y + dy][x + dx] = 'urban';
                    this.elevationMap[y + dy][x + dx] = 1 + Math.floor(Math.random() * 2);
                }
            }
        }
    }
    
    placeScatteredBuildings(density) {
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.terrainMap[y][x] === 'clear' && Math.random() < density) {
                    this.terrainMap[y][x] = 'urban';
                    this.elevationMap[y][x] = 1;
                }
            }
        }
    }
    
    placeRubbleNearBuildings(probability) {
        const rubblePositions = [];
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.terrainMap[y][x] === 'clear') {
                    const neighbors = this.getHexNeighbors(x, y);
                    const nearBuilding = neighbors.some(n => 
                        this.isValid(n.x, n.y) && this.terrainMap[n.y][n.x] === 'urban'
                    );
                    
                    if (nearBuilding && Math.random() < probability) {
                        rubblePositions.push({x, y});
                    }
                }
            }
        }
        
        for (const pos of rubblePositions) {
            this.terrainMap[pos.y][pos.x] = 'rubble';
        }
    }
    
    placeCraters(count) {
        for (let i = 0; i < count; i++) {
            const cx = 2 + Math.floor(Math.random() * (this.width - 4));
            const cy = 2 + Math.floor(Math.random() * (this.height - 4));
            const size = 1 + Math.floor(Math.random() * 2);
            
            // Cráter: centro bajo, bordes altos
            for (let dy = -size; dy <= size; dy++) {
                for (let dx = -size; dx <= size; dx++) {
                    const dist = Math.abs(dx) + Math.abs(dy);
                    if (dist <= size && this.isValid(cx + dx, cy + dy)) {
                        if (dist === 0) {
                            // Centro del cráter
                            this.elevationMap[cy + dy][cx + dx] = 0;
                            this.terrainMap[cy + dy][cx + dx] = 'rough';
                        } else if (dist === size) {
                            // Borde elevado
                            this.elevationMap[cy + dy][cx + dx] = 2;
                        }
                    }
                }
            }
        }
    }
    
    placePond() {
        const cx = 2 + Math.floor(Math.random() * (this.width - 4));
        const cy = 2 + Math.floor(Math.random() * (this.height - 4));
        
        this.placeOrganicCluster(cx, cy, 3 + Math.floor(Math.random() * 4), 'water');
        
        // Bajar elevación del agua
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.terrainMap[y][x] === 'water') {
                    this.elevationMap[y][x] = 0;
                }
            }
        }
    }
    
    carveValleys() {
        // Crear un valle atravesando el mapa
        const startX = Math.floor(Math.random() * 3);
        let currentY = Math.floor(this.height / 2);
        
        for (let x = startX; x < this.width; x++) {
            // Ancho del valle
            for (let dy = -1; dy <= 1; dy++) {
                const y = currentY + dy;
                if (this.isValid(x, y)) {
                    this.elevationMap[y][x] = Math.max(0, this.elevationMap[y][x] - 2);
                    if (dy === 0) {
                        this.terrainMap[y][x] = 'clear';
                    }
                }
            }
            
            // Serpentear
            currentY += Math.floor(Math.random() * 3) - 1;
            currentY = Math.max(1, Math.min(this.height - 2, currentY));
        }
    }
    
    placeRiverInValley() {
        // Encontrar el punto más bajo y poner río ahí
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.elevationMap[y][x] === 0 && this.terrainMap[y][x] === 'clear') {
                    if (Math.random() < 0.3) {
                        this.terrainMap[y][x] = 'water';
                    }
                }
            }
        }
    }
    
    increaseElevationAwayFrom(type, amount) {
        // Calcular distancia a cada hex del tipo dado
        const distances = this.createEmptyGrid(999);
        const queue = [];
        
        // Inicializar con hexes del tipo
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.terrainMap[y][x] === type) {
                    distances[y][x] = 0;
                    queue.push({x, y, dist: 0});
                }
            }
        }
        
        // BFS para calcular distancias
        while (queue.length > 0) {
            const {x, y, dist} = queue.shift();
            
            for (const n of this.getHexNeighbors(x, y)) {
                if (this.isValid(n.x, n.y) && distances[n.y][n.x] > dist + 1) {
                    distances[n.y][n.x] = dist + 1;
                    queue.push({x: n.x, y: n.y, dist: dist + 1});
                }
            }
        }
        
        // Aumentar elevación según distancia
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (distances[y][x] > 2) {
                    this.elevationMap[y][x] = Math.min(4, 
                        this.elevationMap[y][x] + Math.floor(distances[y][x] / 3)
                    );
                }
            }
        }
    }
    
    // ==========================================
    // ASIGNACIÓN DE TILES
    // ==========================================
    
    assignTiles() {
        // 1. Identificar clusters de terreno conectados
        const clusters = this.findTerrainClusters();
        
        // 2. Para cada cluster, intentar rellenarlo con grupos de tiles apropiados
        for (const cluster of clusters) {
            this.fillClusterWithGroups(cluster);
        }
        
        // 3. Rellenar hexes restantes con tiles individuales
        this.assignSingleTiles();
    }
    
    /**
     * Encuentra clusters conectados del mismo tipo de terreno
     */
    findTerrainClusters() {
        const visited = new Set();
        const clusters = [];
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                const key = `${x},${y}`;
                if (visited.has(key)) continue;
                
                const terrain = this.terrainMap[y][x];
                const cluster = this.floodFillCluster(x, y, terrain, visited);
                
                if (cluster.hexes.length > 0) {
                    clusters.push(cluster);
                }
            }
        }
        
        // Ordenar por tamaño (más grandes primero para mejor cobertura)
        clusters.sort((a, b) => b.hexes.length - a.hexes.length);
        
        return clusters;
    }
    
    /**
     * Flood fill para encontrar un cluster de terreno conectado
     */
    floodFillCluster(startX, startY, terrain, visited) {
        const cluster = {
            terrain: terrain,
            hexes: [],
            category: this.terrainToCategory(terrain)
        };
        
        const queue = [{x: startX, y: startY}];
        
        while (queue.length > 0) {
            const {x, y} = queue.shift();
            const key = `${x},${y}`;
            
            if (visited.has(key)) continue;
            if (!this.isValid(x, y)) continue;
            if (this.terrainMap[y][x] !== terrain) continue;
            
            visited.add(key);
            cluster.hexes.push({x, y, elevation: this.elevationMap[y][x]});
            
            // Añadir vecinos
            for (const n of this.getHexNeighbors(x, y)) {
                const nKey = `${n.x},${n.y}`;
                if (!visited.has(nKey)) {
                    queue.push(n);
                }
            }
        }
        
        return cluster;
    }
    
    /**
     * Convierte tipo de terreno a categoría de tile
     */
    terrainToCategory(terrain) {
        const mapping = {
            'clear': 'terrain',
            'woods': 'woods',
            'woods_heavy': 'woods_heavy',
            'water': 'water',
            'water_depth0': 'water',
            'rough': 'rough',
            'rubble': 'rubble',
            'urban': 'urban',
            'hazards': 'hazards'
        };
        return mapping[terrain] || 'terrain';
    }
    
    /**
     * Rellena un cluster con grupos de tiles apropiados
     */
    fillClusterWithGroups(cluster) {
        if (!this.tileGroups?.groups) return;
        
        // Crear set de hexes disponibles en el cluster
        const available = new Set(cluster.hexes.map(h => `${h.x},${h.y}`));
        const hexMap = {};
        for (const h of cluster.hexes) {
            hexMap[`${h.x},${h.y}`] = h;
        }
        
        // Encontrar grupos que coincidan con la categoría del cluster
        const matchingGroups = Object.entries(this.tileGroups.groups)
            .filter(([id, group]) => this.categoryMatches(cluster.category, group.category))
            .sort((a, b) => b[1].tiles.length - a[1].tiles.length); // Más grandes primero
        
        if (matchingGroups.length === 0) return;
        
        // Intentar colocar grupos hasta llenar el cluster
        let attempts = 0;
        const maxAttempts = cluster.hexes.length * 3;
        
        while (available.size > 0 && attempts < maxAttempts) {
            attempts++;
            
            // Elegir un hex disponible aleatorio como punto de partida
            const availableArray = Array.from(available);
            const startKey = availableArray[Math.floor(Math.random() * availableArray.length)];
            const [startX, startY] = startKey.split(',').map(Number);
            
            // Intentar colocar un grupo aleatorio que encaje
            let placed = false;
            
            // Mezclar grupos para variedad
            const shuffledGroups = [...matchingGroups].sort(() => Math.random() - 0.5);
            
            for (const [groupId, group] of shuffledGroups) {
                if (this.canPlaceGroupInCluster(startX, startY, group, available)) {
                    this.placeGroupFromCluster(startX, startY, group, groupId, available, hexMap);
                    placed = true;
                    break;
                }
            }
            
            // Si no se pudo colocar ningún grupo, marcar este hex para tile individual
            if (!placed) {
                available.delete(startKey);
            }
        }
    }
    
    /**
     * Verifica si las categorías son compatibles
     */
    categoryMatches(terrainCategory, groupCategory) {
        // Mapeo de compatibilidad
        const compatible = {
            'terrain': ['terrain'],
            'woods': ['woods'],
            'woods_heavy': ['woods_heavy', 'woods'],
            'water': ['water'],
            'rough': ['rough'],
            'rubble': ['rubble'],
            'urban': ['urban'],
            'hazards': ['hazards']
        };
        
        const validCategories = compatible[terrainCategory] || [];
        return validCategories.includes(groupCategory);
    }
    
    /**
     * Verifica si un grupo puede colocarse dentro del cluster
     */
    canPlaceGroupInCluster(x, y, group, available) {
        if (!group.offsets) return false;
        
        for (const [dx, dy] of group.offsets) {
            const key = `${x + dx},${y + dy}`;
            if (!available.has(key)) return false;
        }
        
        return true;
    }
    
    /**
     * Coloca un grupo en el cluster
     */
    placeGroupFromCluster(x, y, group, groupId, available, hexMap) {
        const baseHex = hexMap[`${x},${y}`];
        const baseElevation = baseHex ? baseHex.elevation : 0;
        
        for (let i = 0; i < group.offsets.length; i++) {
            const [dx, dy] = group.offsets[i];
            const nx = x + dx;
            const ny = y + dy;
            const key = `${nx},${ny}`;
            
            if (this.isValid(nx, ny)) {
                this.tileAssignments[ny][nx] = {
                    tileId: `bt_${groupId}_${i}`,
                    groupId: groupId,
                    groupIndex: i,
                    isCenter: i === 0,
                    elevation: baseElevation
                };
                available.delete(key);
            }
        }
    }
    
    assignSingleTiles() {
        // Mapeo de terreno a tiles SOLO individuales (sin sufijo _X son singles)
        // Los tiles con _X son partes de grupos y NO deben usarse aquí
        const terrainToSingles = {
            'clear': ['11'],  // Single grass hex (único tile individual de terreno)
            'woods': ['11'],  // No hay singles de woods, usar grass (los grupos cubrirán)
            'woods_heavy': ['11'],  // No hay singles, usar grass
            'water': ['27', '28', '29', '30'],  // Water singles
            'water_depth0': ['27'],
            'rough': ['59', '60', '61', '62', '63', '64', '65', '66'],  // Rocky/rough singles
            'rubble': ['67', '68', '69', '70'],  // Rubble singles
            'urban': ['40', '41', '42', '43', '44', '45'],  // Building singles (sin sufijo)
            'hazards': ['71', '72', '73', '74', '75']  // Hazard singles
        };
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.tileAssignments[y][x]) continue; // Ya asignado por grupo
                
                const terrain = this.terrainMap[y][x];
                const tiles = terrainToSingles[terrain] || terrainToSingles['clear'];
                const tileNum = tiles[Math.floor(Math.random() * tiles.length)];
                
                this.tileAssignments[y][x] = {
                    tileId: `bt_${tileNum}`,
                    elevation: this.elevationMap[y][x]
                };
            }
        }
    }
    
    // ==========================================
    // UTILIDADES
    // ==========================================
    
    isValid(x, y) {
        return x >= 0 && x < this.width && y >= 0 && y < this.height;
    }
    
    getHexNeighbors(x, y) {
        // Vecinos para hex grid flat-top
        const isOdd = x % 2 === 1;
        
        if (isOdd) {
            return [
                {x: x-1, y: y},
                {x: x-1, y: y+1},
                {x: x, y: y-1},
                {x: x, y: y+1},
                {x: x+1, y: y},
                {x: x+1, y: y+1}
            ];
        } else {
            return [
                {x: x-1, y: y-1},
                {x: x-1, y: y},
                {x: x, y: y-1},
                {x: x, y: y+1},
                {x: x+1, y: y-1},
                {x: x+1, y: y}
            ];
        }
    }
    
    // ==========================================
    // SALIDA
    // ==========================================
    
    buildMapData() {
        const layers = {
            terrain: [],
            objects: [],
            effects: []
        };
        
        for (let y = 0; y < this.height; y++) {
            layers.terrain[y] = [];
            layers.objects[y] = [];
            layers.effects[y] = [];
            
            for (let x = 0; x < this.width; x++) {
                const assignment = this.tileAssignments[y][x];
                
                if (assignment) {
                    layers.terrain[y][x] = {
                        tileId: assignment.tileId,
                        elevation: assignment.elevation || 0,
                        groupId: assignment.groupId || null,
                        groupIndex: assignment.groupIndex || null
                    };
                } else {
                    layers.terrain[y][x] = {
                        tileId: 'bt_11',
                        elevation: 0
                    };
                }
                
                layers.objects[y][x] = null;
                layers.effects[y][x] = null;
            }
        }
        
        return {
            id: 'map_' + Date.now(),
            name: 'Mapa Generado',
            width: this.width,
            height: this.height,
            gridType: 'hex',
            systemId: 'battletech',
            created: new Date().toISOString(),
            layers: layers
        };
    }
}

// Exportar para uso en map-editor
if (typeof window !== 'undefined') {
    window.BattleTechMapGenerator = BattleTechMapGenerator;
}
