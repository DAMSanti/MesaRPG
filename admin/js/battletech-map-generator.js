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
        // Parámetros aleatorios para variedad
        const forestDensity = 0.12 + Math.random() * 0.12; // 12-24%
        const hilliness = 0.2 + Math.random() * 0.25;      // 20-45%
        const hasStream = Math.random() < 0.4;
        const hasRuins = Math.random() < 0.2;
        const hasPond = Math.random() < 0.3;
        
        // 1. Base: todo llanura nivel 0
        this.fillTerrain('clear', 0);
        
        // 2. Generar elevación con variación
        this.generateSmoothElevation(0, 2, hilliness);
        
        // 3. Múltiples clusters de bosques de diferentes tamaños
        const numForestClusters = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < numForestClusters; i++) {
            const size = 2 + Math.floor(Math.random() * 6);
            this.placeTerrainClusters('woods', forestDensity / numForestClusters, size, size + 4);
        }
        
        // 4. Bosques densos en zonas altas o como núcleo de bosques
        this.placeTerrainOnElevation('woods_heavy', 2, 0.25);
        this.addDenseWoodsCores(0.3);
        
        // 5. Características especiales
        if (hasStream) {
            this.placeNarrowStream();
        }
        if (hasPond) {
            this.placePond();
        }
        if (hasRuins) {
            this.placeRuinedStructure();
        }
        
        // 6. Terreno rocoso disperso y en colinas
        this.scatterTerrain('rough', 0.04);
        this.placeTerrainOnElevation('rough', 2, 0.15);
        
        // 7. Asignar tiles visuales
        this.assignTiles();
    }
    
    /**
     * Bosque: Bosque denso con claros estratégicos
     * Combate cercano, emboscadas
     */
    generateForest() {
        // Parámetros aleatorios
        const clearingDensity = 0.08 + Math.random() * 0.12;
        const heavyWoodsDensity = 0.35 + Math.random() * 0.15;
        const hasStream = Math.random() < 0.6;
        const hasRuins = Math.random() < 0.25;
        const hasCamp = Math.random() < 0.15;
        
        // 1. Base: bosque ligero
        this.fillTerrain('woods', 0);
        
        // 2. Elevación moderada con colinas
        this.generateSmoothElevation(0, 2, 0.25);
        
        // 3. Bosque denso en clusters variados
        const numHeavyClusters = 4 + Math.floor(Math.random() * 4);
        for (let i = 0; i < numHeavyClusters; i++) {
            this.placeTerrainClusters('woods_heavy', heavyWoodsDensity / numHeavyClusters, 4, 10);
        }
        
        // 4. Claros estratégicos - importantes para maniobra
        const numClearings = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < numClearings; i++) {
            this.placeTerrainClusters('clear', clearingDensity, 3, 7);
        }
        
        // 5. Características especiales
        if (hasStream) {
            this.placeNarrowStream();
        }
        if (hasRuins) {
            this.placeRuinedStructure();
        }
        if (hasCamp) {
            this.placeSmallCamp();
        }
        
        // 6. Rocas y terreno difícil disperso
        this.scatterTerrain('rough', 0.03);
        
        // 7. Añadir bordes de bosque denso en zonas altas
        this.placeTerrainOnElevation('woods_heavy', 2, 0.4);
        
        this.assignTiles();
    }
    
    /**
     * Ciudad: Grid urbano con edificios y calles
     * Combate urbano, líneas de fuego cortas
     */
    generateCity() {
        // Parámetros aleatorios
        const density = 0.6 + Math.random() * 0.2;     // 60-80% edificios
        const destruction = Math.random() * 0.3;       // 0-30% destrucción
        const hasParks = Math.random() < 0.5;
        const hasPlaza = Math.random() < 0.4;
        
        // 1. Base: llanura (calles)
        this.fillTerrain('clear', 0);
        
        // 2. Elevación muy baja (ciudad en llanura)
        this.generateSmoothElevation(0, 1, 0.08);
        
        // 3. Colocar bloques de edificios con densidad variable
        this.placeBuildingBlocks(density);
        
        // 4. Añadir escombros según nivel de destrucción
        this.placeRubbleNearBuildings(0.2 + destruction);
        if (destruction > 0.15) {
            this.scatterTerrain('rubble', destruction * 0.3);
        }
        
        // 5. Parques (bosques pequeños) 
        if (hasParks) {
            const numParks = 1 + Math.floor(Math.random() * 2);
            for (let i = 0; i < numParks; i++) {
                this.placeTerrainClusters('woods', 0.04, 2, 5);
            }
        }
        
        // 6. Plaza central (área despejada grande)
        if (hasPlaza) {
            this.placePlaza();
        }
        
        this.assignTiles();
    }
    
    /**
     * Río: Río atravesando llanuras con bosques ribereños
     * Control del vado/puente es clave
     */
    generateRiver() {
        // Parámetros aleatorios
        const riverWidth = 1;    // Río de 1 hex de ancho para mejor visualización
        const forestDensity = 0.15 + Math.random() * 0.15;
        const meanders = Math.random() < 0.5;
        
        // 1. Base: llanura
        this.fillTerrain('clear', 0);
        
        // 2. Elevación: más alta lejos del río
        this.generateSmoothElevation(0, 2, 0.25);
        
        // 3. Río principal atravesando el mapa
        this.placeRiver(2, riverWidth, meanders);
        
        // 4. Bosques ribereños densos (cerca del agua)
        this.placeTerrainNear('water', 'woods', 2, forestDensity * 2);
        this.placeTerrainNear('water', 'woods_heavy', 1, forestDensity);
        
        // 5. Bosques adicionales en zonas altas
        this.placeTerrainClusters('woods', forestDensity, 3, 6);
        
        // 6. Colinas lejos del río
        this.increaseElevationAwayFrom('water', 1);
        
        // 7. Algo de rough en las orillas
        this.placeTerrainNear('water', 'rough', 1, 0.1);
        
        this.assignTiles();
    }
    
    /**
     * Ruinas: Ciudad destruida, escombros y peligros
     * Combate caótico, peligros ambientales
     */
    generateRuins() {
        // Parámetros aleatorios
        const destruction = 0.5 + Math.random() * 0.4;    // 50-90%
        const hasFires = Math.random() < 0.3;
        const hasHazards = Math.random() < 0.4;
        const survivingBuildings = 0.1 + Math.random() * 0.15;
        
        // 1. Base: mezcla de clear y rubble
        this.fillTerrain('clear', 0);
        
        // 2. Elevación irregular (cráteres y montículos)
        this.generateChaoticElevation(0, 3);
        
        // 3. Escombros abundantes según destrucción
        this.placeTerrainClusters('rubble', destruction * 0.5, 3, 8);
        this.scatterTerrain('rubble', destruction * 0.15);
        
        // 4. Edificios supervivientes
        this.placeScatteredBuildings(survivingBuildings);
        
        // 5. Cráteres múltiples
        const numCraters = 3 + Math.floor(Math.random() * 5);
        this.placeCraters(numCraters);
        
        // 6. Zonas de peligro (humo, fuego, minas)
        if (hasHazards) {
            this.scatterTerrain('hazards', 0.05 + destruction * 0.05);
        }
        if (hasFires) {
            // Humo cerca de edificios
            this.placeHazardsNearBuildings(0.15);
        }
        
        // 7. Vegetación recuperando terreno
        this.scatterTerrain('woods', 0.03);
        
        this.assignTiles();
    }
    
    /**
     * Desierto: Terreno rocoso con poca cobertura
     * Largo alcance, calor es factor
     */
    generateDesert() {
        // Parámetros aleatorios
        const rockDensity = 0.2 + Math.random() * 0.15;
        const hasOasis = Math.random() < 0.4;
        const hasWadi = Math.random() < 0.3;  // Río seco
        const hasRuins = Math.random() < 0.2;
        const elevationVariety = 0.3 + Math.random() * 0.2;
        
        // 1. Base: clear (arena)
        this.fillTerrain('clear', 0);
        
        // 2. Elevación variable (dunas y mesetas)
        this.generateSmoothElevation(0, 3, elevationVariety);
        
        // 3. Formaciones rocosas en clusters variados
        const numRockFormations = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < numRockFormations; i++) {
            this.placeTerrainClusters('rough', rockDensity / numRockFormations, 2, 6);
        }
        
        // 4. Mesetas (rough en elevación alta)
        this.placeTerrainOnElevation('rough', 3, 0.6);
        this.placeTerrainOnElevation('rough', 2, 0.3);
        
        // 5. Oasis (agua + vegetación)
        if (hasOasis) {
            this.placeOasis();
        }
        
        // 6. Wadi (cauce seco - rough en línea)
        if (hasWadi) {
            this.placeWadi();
        }
        
        // 7. Ruinas antiguas
        if (hasRuins) {
            this.placeAncientRuins();
        }
        
        this.assignTiles();
    }
    
    /**
     * Montañas: Terreno muy elevado con pasos estrechos
     * Choke points, saltos importantes
     */
    generateMountains() {
        // Parámetros aleatorios
        const peakCount = 2 + Math.floor(Math.random() * 3);
        const valleyWidth = 1 + Math.floor(Math.random() * 2);
        const hasLake = Math.random() < 0.3;
        const hasPass = Math.random() < 0.5;
        const forestDensity = 0.1 + Math.random() * 0.15;
        
        // 1. Base: rough (terreno montañoso)
        this.fillTerrain('rough', 1);
        
        // 2. Elevación alta y variada con múltiples picos
        this.generateMountainousElevation(peakCount);
        
        // 3. Picos marcados (nivel 4)
        this.placeTerrainOnElevation('rough', 4, 0.9);
        this.placeTerrainOnElevation('rough', 3, 0.7);
        
        // 4. Valles (clear nivel 0-1)
        this.carveValleys(valleyWidth);
        
        // 5. Paso de montaña (si aplica)
        if (hasPass) {
            this.carveMountainPass();
        }
        
        // 6. Bosques en laderas medias
        this.placeTerrainOnElevation('woods', 1, forestDensity * 2);
        this.placeTerrainOnElevation('woods', 2, forestDensity);
        this.placeTerrainOnElevation('woods_heavy', 1, forestDensity * 0.5);
        
        // 7. Lago de montaña
        if (hasLake) {
            this.placeMountainLake();
        }
        
        // 8. Posible río en valle
        if (Math.random() < 0.35) {
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
            
            // Preferir tamaños que coincidan con grupos de tiles (7, 9, 2, 3, 4)
            const preferredSizes = [7, 9, 7, 4, 3, 2, 7];
            const size = preferredSizes[Math.floor(Math.random() * preferredSizes.length)];
            
            // Colocar cluster compacto
            placed += this.placeCompactCluster(cx, cy, size, type);
        }
    }
    
    /**
     * Coloca un cluster compacto en forma hexagonal
     * Esto facilita que los grupos de tiles encajen mejor
     */
    placeCompactCluster(cx, cy, size, type) {
        let placed = 0;
        
        // Patrones predefinidos que coinciden con grupos de tiles
        const patterns = {
            2: [[0, 0], [0, 1]],  // Vertical 2
            3: [[0, 0], [0, 1], [1, 0]],  // Triángulo
            4: [[0, 0], [0, 1], [-1, 0], [1, 0]],  // Cruz
            7: [[0, 0], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [0, -1]],  // Mega7
            9: [[0, 0], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [0, -1], [-1, -1], [1, -1]]  // Mega9
        };
        
        const pattern = patterns[size] || patterns[7];
        
        for (const [dx, dy] of pattern) {
            const x = cx + dx;
            const y = cy + dy;
            
            if (!this.isValid(x, y)) continue;
            
            // No sobrescribir agua o urban
            if (this.isWater(x, y) || this.terrainMap[y][x] === 'urban') {
                continue;
            }
            
            this.terrainMap[y][x] = type;
            placed++;
        }
        
        return placed;
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
            
            // No sobrescribir agua o urban
            if (this.isWater(x, y) || this.terrainMap[y][x] === 'urban') {
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
        // Soporta 'water' como alias para water_river + water_lake
        const types = type === 'water' 
            ? ['water', 'water_river', 'water_lake'] 
            : [type];
            
        for (let dy = -distance; dy <= distance; dy++) {
            for (let dx = -distance; dx <= distance; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (this.isValid(nx, ny) && types.includes(this.terrainMap[ny][nx])) {
                    return true;
                }
            }
        }
        return false;
    }
    
    /**
     * Verifica si un hex es de tipo agua (cualquier variante)
     */
    isWater(x, y) {
        if (!this.isValid(x, y)) return false;
        const t = this.terrainMap[y][x];
        return t === 'water' || t === 'water_river' || t === 'water_lake';
    }
    
    placeRiver(depth, width = 2, meanders = true) {
        // Río con dirección guardada para cada hex
        const vertical = Math.random() < 0.5;
        this.riverDirection = vertical ? 'vertical' : 'horizontal';
        this.riverPath = [];
        this.riverDirections = {}; // Mapa de direcciones: key -> {from, to}
        
        // Calcular posición inicial centrada
        let startX = vertical 
            ? Math.floor(this.width / 2) + Math.floor(Math.random() * 4) - 2
            : 0;
        let startY = vertical 
            ? 0 
            : Math.floor(this.height / 2) + Math.floor(Math.random() * 4) - 2;
        
        // Generar path del río con meandros suaves
        let current = { x: startX, y: startY };
        let prev = null;
        const end = vertical ? this.height : this.width;
        const meanderChance = meanders ? 0.25 : 0.1;
        
        for (let i = 0; i < end; i++) {
            // Calcular siguiente posición
            let next = { x: current.x, y: current.y };
            if (vertical) {
                next.y++;
                if (Math.random() < meanderChance) {
                    next.x += Math.random() < 0.5 ? 1 : -1;
                    next.x = Math.max(2, Math.min(this.width - 3, next.x));
                }
            } else {
                next.x++;
                if (Math.random() < meanderChance) {
                    next.y += Math.random() < 0.5 ? 1 : -1;
                    next.y = Math.max(2, Math.min(this.height - 3, next.y));
                }
            }
            
            // Guardar posición y dirección
            this.riverPath.push({ x: current.x, y: current.y });
            const key = `${current.x},${current.y}`;
            
            // Calcular lado de entrada (desde dónde viene el agua) y lado de salida (hacia dónde va)
            // fromDir: el lado por donde ENTRA el agua (opuesto de la dirección desde prev)
            // toDir: el lado por donde SALE el agua (dirección hacia next)
            let fromSide, toSide;
            
            if (prev) {
                // getDirection(prev, current) nos da la dirección de prev a current
                // pero queremos el lado del hex current por donde entra, que es el opuesto
                const entryDir = this.getDirection(prev, current);
                fromSide = this.oppositeDir(entryDir);
            } else {
                fromSide = vertical ? 'N' : 'NW';
            }
            
            toSide = this.getDirection(current, next);
            this.riverDirections[key] = { from: fromSide, to: toSide };
            
            // Marcar como río
            if (this.isValid(current.x, current.y)) {
                this.terrainMap[current.y][current.x] = 'water_river';
                this.elevationMap[current.y][current.x] = 0;
            }
            
            // Avanzar
            prev = { ...current };
            current = next;
        }
    }
    
    /**
     * Calcula el lado del hexágono por donde se conectan dos hexes adyacentes
     * 
     * Lados del hexágono (flat-top, sentido horario desde arriba):
     *   0 = N (arriba)
     *   1 = NE (arriba-derecha)
     *   2 = SE (abajo-derecha)
     *   3 = S (abajo)
     *   4 = SW (abajo-izquierda)
     *   5 = NW (arriba-izquierda)
     * 
     * En hex grid flat-top con offset en columnas impares:
     * - Columna par:  vecinos son (-1,-1), (+1,-1), (-1,0), (+1,0), (-1,+1)NO, (+1,+1)NO... 
     *   Corrección: los vecinos dependen de la paridad de x
     */
    getDirection(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const isFromOdd = from.x % 2 === 1;
        
        // Para hex flat-top con columnas impares desplazadas hacia abajo:
        // Movimiento puro vertical (misma columna)
        if (dx === 0) {
            if (dy < 0) return 'N';  // Lado 0
            if (dy > 0) return 'S';  // Lado 3
        }
        
        // Movimiento hacia la derecha (dx > 0)
        if (dx > 0) {
            if (isFromOdd) {
                // Desde columna impar: vecino derecho-arriba es (x+1, y), derecho-abajo es (x+1, y+1)
                if (dy <= 0) return 'NE';  // Lado 1
                if (dy > 0) return 'SE';   // Lado 2
            } else {
                // Desde columna par: vecino derecho-arriba es (x+1, y-1), derecho-abajo es (x+1, y)
                if (dy < 0) return 'NE';   // Lado 1
                if (dy >= 0) return 'SE';  // Lado 2
            }
        }
        
        // Movimiento hacia la izquierda (dx < 0)
        if (dx < 0) {
            if (isFromOdd) {
                // Desde columna impar: vecino izq-arriba es (x-1, y), izq-abajo es (x-1, y+1)
                if (dy <= 0) return 'NW';  // Lado 5
                if (dy > 0) return 'SW';   // Lado 4
            } else {
                // Desde columna par: vecino izq-arriba es (x-1, y-1), izq-abajo es (x-1, y)
                if (dy < 0) return 'NW';   // Lado 5
                if (dy >= 0) return 'SW';  // Lado 4
            }
        }
        
        return 'S'; // Default
    }
    
    /**
     * Devuelve la dirección opuesta (lado opuesto del hexágono)
     */
    oppositeDir(dir) {
        const opposites = {
            'N': 'S',
            'S': 'N',
            'NE': 'SW',
            'SW': 'NE',
            'SE': 'NW',
            'NW': 'SE'
        };
        return opposites[dir] || 'N';
    }
    
    /**
     * Coloca un lago usando grupos autocontenidos
     */
    placeLake(centerX, centerY, size = 'medium') {
        const sizes = {
            'small': 3,
            'medium': 5,
            'large': 7
        };
        const radius = sizes[size] || 5;
        
        // Rellenar área circular con agua de lago
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist <= radius * 0.8 + Math.random() * radius * 0.3) {
                    const x = centerX + dx;
                    const y = centerY + dy;
                    if (this.isValid(x, y)) {
                        this.terrainMap[y][x] = 'water_lake';
                        this.elevationMap[y][x] = 0;
                    }
                }
            }
        }
    }
    
    placeFordsOnRiver() {
        // Encontrar hexes de agua de río y convertir algunos a depth 0 (vados)
        let fords = 0;
        const maxFords = 2;
        
        for (let y = 0; y < this.height && fords < maxFords; y++) {
            for (let x = 0; x < this.width && fords < maxFords; x++) {
                if (this.terrainMap[y][x] === 'water_river' && Math.random() < 0.05) {
                    // Marcar como vado (se representará distinto)
                    this.terrainMap[y][x] = 'water_depth0';
                    fords++;
                }
            }
        }
    }
    
    placeBuildingBlocks(density = 0.7) {
        const blockSize = 3;
        const streetWidth = 2;
        
        for (let by = 1; by < this.height - blockSize; by += blockSize + streetWidth) {
            for (let bx = 1; bx < this.width - blockSize; bx += blockSize + streetWidth) {
                // Probabilidad basada en densidad
                if (Math.random() < density) {
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
        // Crear un lago de tamaño compatible con grupos mega7 (7 hexes)
        const cx = 3 + Math.floor(Math.random() * (this.width - 6));
        const cy = 3 + Math.floor(Math.random() * (this.height - 6));
        
        // Patrón mega7: centro + 6 vecinos (tamaño ideal para grupos de agua)
        const mega7Offsets = [
            [0, 0], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [0, -1]
        ];
        
        // Colocar lago con forma compatible con grupos
        for (const [dx, dy] of mega7Offsets) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (this.isValid(nx, ny)) {
                this.terrainMap[ny][nx] = 'water_lake';
                this.elevationMap[ny][nx] = 0;
            }
        }
        
        // Opcionalmente añadir más hexes alrededor para lagos más grandes
        if (Math.random() < 0.5) {
            // Segundo anillo parcial
            const extraOffsets = [
                [-2, 0], [-2, 1], [-1, 2], [0, 2], [1, 2], [2, 1], [2, 0]
            ];
            for (const [dx, dy] of extraOffsets) {
                if (Math.random() < 0.6) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (this.isValid(nx, ny)) {
                        this.terrainMap[ny][nx] = 'water_lake';
                        this.elevationMap[ny][nx] = 0;
                    }
                }
            }
        }
        
        // Bajar elevación del agua
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.isWater(x, y)) {
                    this.elevationMap[y][x] = 0;
                }
            }
        }
    }
    
    carveValleys(valleyWidth = 1) {
        // Crear un valle atravesando el mapa
        const startX = Math.floor(Math.random() * 3);
        let currentY = Math.floor(this.height / 2);
        
        for (let x = startX; x < this.width; x++) {
            // Ancho del valle configurable
            for (let dy = -valleyWidth; dy <= valleyWidth; dy++) {
                const y = currentY + dy;
                if (this.isValid(x, y)) {
                    this.elevationMap[y][x] = Math.max(0, this.elevationMap[y][x] - 2);
                    if (Math.abs(dy) <= 1) {
                        this.terrainMap[y][x] = 'clear';
                    }
                }
            }
            
            // Serpentear
            currentY += Math.floor(Math.random() * 3) - 1;
            currentY = Math.max(valleyWidth + 1, Math.min(this.height - valleyWidth - 2, currentY));
        }
    }
    
    placeRiverInValley() {
        // Encontrar el punto más bajo y poner río ahí
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.elevationMap[y][x] === 0 && this.terrainMap[y][x] === 'clear') {
                    if (Math.random() < 0.3) {
                        this.terrainMap[y][x] = 'water_river';
                    }
                }
            }
        }
    }
    
    increaseElevationAwayFrom(type, amount) {
        // Calcular distancia a cada hex del tipo dado
        const distances = this.createEmptyGrid(999);
        const queue = [];
        
        // Soporta 'water' como alias para todos los tipos de agua
        const types = type === 'water' 
            ? ['water', 'water_river', 'water_lake'] 
            : [type];
        
        // Inicializar con hexes del tipo
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (types.includes(this.terrainMap[y][x])) {
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
    // CARACTERÍSTICAS ESPECIALES
    // ==========================================
    
    /**
     * Añade núcleos de bosque denso dentro de bosques existentes
     */
    addDenseWoodsCores(probability) {
        for (let y = 1; y < this.height - 1; y++) {
            for (let x = 1; x < this.width - 1; x++) {
                if (this.terrainMap[y][x] === 'woods') {
                    // Contar vecinos que también son bosque
                    const neighbors = this.getHexNeighbors(x, y);
                    const woodsNeighbors = neighbors.filter(n => 
                        this.isValid(n.x, n.y) && 
                        (this.terrainMap[n.y][n.x] === 'woods' || this.terrainMap[n.y][n.x] === 'woods_heavy')
                    ).length;
                    
                    // Si está rodeado de bosque, hacerlo denso
                    if (woodsNeighbors >= 4 && Math.random() < probability) {
                        this.terrainMap[y][x] = 'woods_heavy';
                    }
                }
            }
        }
    }
    
    /**
     * Coloca un arroyo estrecho (1-2 hexes de ancho)
     */
    placeNarrowStream() {
        const vertical = Math.random() < 0.5;
        const startOffset = Math.floor(Math.random() * (vertical ? this.width : this.height) * 0.6) + 
                           Math.floor((vertical ? this.width : this.height) * 0.2);
        
        let current = vertical 
            ? { x: startOffset, y: 0 }
            : { x: 0, y: startOffset };
        
        const end = vertical ? this.height : this.width;
        
        for (let i = 0; i < end; i++) {
            if (this.isValid(current.x, current.y)) {
                this.terrainMap[current.y][current.x] = 'water_river';
                this.elevationMap[current.y][current.x] = 0;
            }
            
            // Avanzar con serpenteo suave
            if (vertical) {
                current.y++;
                if (Math.random() < 0.35) {
                    current.x += Math.floor(Math.random() * 3) - 1;
                    current.x = Math.max(0, Math.min(this.width - 1, current.x));
                }
            } else {
                current.x++;
                if (Math.random() < 0.35) {
                    current.y += Math.floor(Math.random() * 3) - 1;
                    current.y = Math.max(0, Math.min(this.height - 1, current.y));
                }
            }
        }
    }
    
    /**
     * Coloca una estructura en ruinas
     */
    placeRuinedStructure() {
        const cx = 2 + Math.floor(Math.random() * (this.width - 4));
        const cy = 2 + Math.floor(Math.random() * (this.height - 4));
        const size = 1 + Math.floor(Math.random() * 2);
        
        // Mezcla de urban (edificio) y rubble (escombros)
        for (let dy = -size; dy <= size; dy++) {
            for (let dx = -size; dx <= size; dx++) {
                if (this.isValid(cx + dx, cy + dy) && this.terrainMap[cy + dy][cx + dx] === 'clear') {
                    if (Math.random() < 0.4) {
                        this.terrainMap[cy + dy][cx + dx] = 'urban';
                        this.elevationMap[cy + dy][cx + dx] = 1;
                    } else if (Math.random() < 0.6) {
                        this.terrainMap[cy + dy][cx + dx] = 'rubble';
                    }
                }
            }
        }
    }
    
    /**
     * Coloca un pequeño campamento
     */
    placeSmallCamp() {
        const cx = 2 + Math.floor(Math.random() * (this.width - 4));
        const cy = 2 + Math.floor(Math.random() * (this.height - 4));
        
        // Centro despejado
        if (this.isValid(cx, cy)) {
            this.terrainMap[cy][cx] = 'clear';
        }
        
        // Algunas estructuras pequeñas alrededor
        const neighbors = this.getHexNeighbors(cx, cy);
        for (const n of neighbors) {
            if (this.isValid(n.x, n.y) && Math.random() < 0.3) {
                this.terrainMap[n.y][n.x] = 'urban';
                this.elevationMap[n.y][n.x] = 1;
            }
        }
    }
    
    /**
     * Coloca una plaza central
     */
    placePlaza() {
        const cx = Math.floor(this.width / 2);
        const cy = Math.floor(this.height / 2);
        const size = 2;
        
        for (let dy = -size; dy <= size; dy++) {
            for (let dx = -size; dx <= size; dx++) {
                if (this.isValid(cx + dx, cy + dy)) {
                    this.terrainMap[cy + dy][cx + dx] = 'clear';
                    this.elevationMap[cy + dy][cx + dx] = 0;
                }
            }
        }
    }
    
    /**
     * Coloca una isla en medio del agua
     */
    placeIslandInWater() {
        // Encontrar centro de masa del agua
        let waterHexes = [];
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.isWater(x, y)) {
                    waterHexes.push({x, y});
                }
            }
        }
        
        if (waterHexes.length < 10) return;
        
        // Elegir un hex de agua aleatorio para la isla
        const island = waterHexes[Math.floor(Math.random() * waterHexes.length)];
        
        // Convertir a clear con algo de vegetación
        if (this.isValid(island.x, island.y)) {
            this.terrainMap[island.y][island.x] = 'clear';
            this.elevationMap[island.y][island.x] = 1;
            
            // Posible árbol en la isla
            if (Math.random() < 0.5) {
                this.terrainMap[island.y][island.x] = 'woods';
            }
        }
    }
    
    /**
     * Coloca un puente sobre el río
     */
    placeBridge() {
        // Encontrar hexes de agua y colocar un par como vado/puente
        for (let y = 2; y < this.height - 2; y++) {
            for (let x = 2; x < this.width - 2; x++) {
                if (this.isWater(x, y)) {
                    // Convertir este y vecino a clear (puente)
                    this.terrainMap[y][x] = 'clear';
                    const neighbors = this.getHexNeighbors(x, y);
                    for (const n of neighbors) {
                        if (this.isValid(n.x, n.y) && this.isWater(n.x, n.y)) {
                            this.terrainMap[n.y][n.x] = 'clear';
                            return; // Solo un puente
                        }
                    }
                    return;
                }
            }
        }
    }
    
    /**
     * Coloca hazards cerca de edificios (para ruinas con fuego)
     */
    placeHazardsNearBuildings(probability) {
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.terrainMap[y][x] === 'clear' || this.terrainMap[y][x] === 'rubble') {
                    const neighbors = this.getHexNeighbors(x, y);
                    const nearBuilding = neighbors.some(n => 
                        this.isValid(n.x, n.y) && this.terrainMap[n.y][n.x] === 'urban'
                    );
                    
                    if (nearBuilding && Math.random() < probability) {
                        this.terrainMap[y][x] = 'hazards';
                    }
                }
            }
        }
    }
    
    /**
     * Coloca un oasis (agua + vegetación)
     */
    placeOasis() {
        const cx = 3 + Math.floor(Math.random() * (this.width - 6));
        const cy = 3 + Math.floor(Math.random() * (this.height - 6));
        
        // Centro: agua (lago pequeño)
        if (this.isValid(cx, cy)) {
            this.terrainMap[cy][cx] = 'water_lake';
            this.elevationMap[cy][cx] = 0;
        }
        
        // Anillo de vegetación
        const neighbors = this.getHexNeighbors(cx, cy);
        for (const n of neighbors) {
            if (this.isValid(n.x, n.y)) {
                this.terrainMap[n.y][n.x] = 'woods';
            }
        }
        
        // Segundo anillo: más vegetación dispersa
        for (const n of neighbors) {
            const outer = this.getHexNeighbors(n.x, n.y);
            for (const o of outer) {
                if (this.isValid(o.x, o.y) && Math.random() < 0.4) {
                    if (this.terrainMap[o.y][o.x] === 'clear') {
                        this.terrainMap[o.y][o.x] = 'woods';
                    }
                }
            }
        }
    }
    
    /**
     * Coloca un wadi (cauce seco)
     */
    placeWadi() {
        const vertical = Math.random() < 0.5;
        let current = vertical 
            ? { x: Math.floor(this.width / 2), y: 0 }
            : { x: 0, y: Math.floor(this.height / 2) };
        
        const end = vertical ? this.height : this.width;
        
        for (let i = 0; i < end; i++) {
            if (this.isValid(current.x, current.y)) {
                this.terrainMap[current.y][current.x] = 'rough';
                this.elevationMap[current.y][current.x] = Math.max(0, this.elevationMap[current.y][current.x] - 1);
            }
            
            if (vertical) {
                current.y++;
                if (Math.random() < 0.4) current.x += Math.floor(Math.random() * 3) - 1;
                current.x = Math.max(0, Math.min(this.width - 1, current.x));
            } else {
                current.x++;
                if (Math.random() < 0.4) current.y += Math.floor(Math.random() * 3) - 1;
                current.y = Math.max(0, Math.min(this.height - 1, current.y));
            }
        }
    }
    
    /**
     * Coloca ruinas antiguas
     */
    placeAncientRuins() {
        const cx = 2 + Math.floor(Math.random() * (this.width - 4));
        const cy = 2 + Math.floor(Math.random() * (this.height - 4));
        
        // Patrón de ruinas dispersas
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                if (this.isValid(cx + dx, cy + dy) && Math.random() < 0.3) {
                    this.terrainMap[cy + dy][cx + dx] = 'rubble';
                    this.elevationMap[cy + dy][cx + dx] = 1;
                }
            }
        }
    }
    
    /**
     * Genera elevación con múltiples picos de montaña
     */
    generateMountainousElevation(peakCount) {
        // Primero generar base suave
        this.generateSmoothElevation(1, 3, 0.4);
        
        // Añadir picos
        for (let p = 0; p < peakCount; p++) {
            const px = 2 + Math.floor(Math.random() * (this.width - 4));
            const py = 2 + Math.floor(Math.random() * (this.height - 4));
            const peakSize = 2 + Math.floor(Math.random() * 3);
            
            for (let dy = -peakSize; dy <= peakSize; dy++) {
                for (let dx = -peakSize; dx <= peakSize; dx++) {
                    const dist = Math.abs(dx) + Math.abs(dy);
                    if (dist <= peakSize && this.isValid(px + dx, py + dy)) {
                        const elevation = 4 - Math.floor(dist / 2);
                        this.elevationMap[py + dy][px + dx] = Math.max(
                            this.elevationMap[py + dy][px + dx],
                            elevation
                        );
                    }
                }
            }
        }
    }
    
    /**
     * Talla un paso de montaña
     */
    carveMountainPass() {
        // Crear un paso de este a oeste o norte a sur
        const horizontal = Math.random() < 0.5;
        const passY = Math.floor(this.height / 2) + Math.floor(Math.random() * 4) - 2;
        const passX = Math.floor(this.width / 2) + Math.floor(Math.random() * 4) - 2;
        
        if (horizontal) {
            for (let x = 0; x < this.width; x++) {
                const y = passY + Math.floor(Math.random() * 3) - 1;
                if (this.isValid(x, y)) {
                    this.elevationMap[y][x] = Math.min(1, this.elevationMap[y][x]);
                    this.terrainMap[y][x] = 'clear';
                }
            }
        } else {
            for (let y = 0; y < this.height; y++) {
                const x = passX + Math.floor(Math.random() * 3) - 1;
                if (this.isValid(x, y)) {
                    this.elevationMap[y][x] = Math.min(1, this.elevationMap[y][x]);
                    this.terrainMap[y][x] = 'clear';
                }
            }
        }
    }
    
    /**
     * Coloca un lago de montaña
     */
    placeMountainLake() {
        // Buscar zona de baja elevación
        let bestX = Math.floor(this.width / 2);
        let bestY = Math.floor(this.height / 2);
        let lowestElevation = 999;
        
        for (let y = 2; y < this.height - 2; y++) {
            for (let x = 2; x < this.width - 2; x++) {
                if (this.elevationMap[y][x] < lowestElevation) {
                    lowestElevation = this.elevationMap[y][x];
                    bestX = x;
                    bestY = y;
                }
            }
        }
        
        // Colocar lago pequeño
        this.terrainMap[bestY][bestX] = 'water_lake';
        this.elevationMap[bestY][bestX] = 0;
        
        const neighbors = this.getHexNeighbors(bestX, bestY);
        for (const n of neighbors) {
            if (this.isValid(n.x, n.y) && Math.random() < 0.5) {
                this.terrainMap[n.y][n.x] = 'water_lake';
                this.elevationMap[n.y][n.x] = 0;
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
            'water': 'water_lake',  // Por defecto lagos
            'water_lake': 'water_lake',
            'water_river': 'water_river',
            'water_depth0': 'water_lake',
            'rough': 'rough',
            'rubble': 'rubble',
            'urban': 'urban',
            'hazards': 'hazards'
        };
        return mapping[terrain] || 'terrain';
    }
    
    /**
     * Rellena un cluster con grupos de tiles apropiados
     * Estrategia: intentar colocar grupos grandes primero, luego más pequeños
     * Para terrain (clear), colocar múltiples grupos mega7 espaciados
     * 
     * IMPORTANTE: Los grupos de tiles NO se rotan porque cada tile tiene una
     * imagen específica diseñada para su posición relativa en el grupo.
     * Rotar los offsets rompería la correspondencia tile-imagen.
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
        
        // Para terrain (clear), usar estrategia especial: colocar mega7 en patrón de cuadrícula
        if (cluster.category === 'terrain' && cluster.hexes.length > 20) {
            this.fillTerrainWithMegaGroups(cluster, available, hexMap, matchingGroups);
            return;
        }
        
        // Para ríos, usar grupos v4 a lo largo del path
        if (cluster.category === 'water_river') {
            this.fillRiverWithGroups(cluster, available, hexMap, matchingGroups);
            return;
        }
        
        // Para lagos, usar grupos autocontenidos (mega7 preferido)
        if (cluster.category === 'water_lake') {
            this.fillLakeWithGroups(cluster, available, hexMap, matchingGroups);
            return;
        }
        
        // Estrategia estándar para otros tipos de terreno
        this.fillClusterStandard(cluster, available, hexMap, matchingGroups);
    }
    
    /**
     * Rellena río: NO usar grupos de río (tienen formas fijas que no conectan)
     * En su lugar, marcar para usar tiles singles de agua que se mezclan mejor
     */
    fillRiverWithGroups(cluster, available, hexMap, matchingGroups) {
        // Para ríos, NO colocar grupos - dejar que assignSingleTiles use tiles 27-30
        // Estos son agua genérica sin bordes que se mezcla mejor
        // Simplemente no hacer nada aquí - los hexes se llenarán con singles
    }
    
    /**
     * Rellena lago con grupos autocontenidos, prefiriendo mega7
     */
    fillLakeWithGroups(cluster, available, hexMap, matchingGroups) {
        // Solo usar grupos mega7 que son realmente autocontenidos (24, 25)
        const mega7Groups = matchingGroups.filter(([id, g]) => 
            g.shape === 'mega7' && g.tiles.length === 7
        );
        
        if (mega7Groups.length === 0) {
            // Sin grupos mega7, no colocar grupos - usar singles
            return;
        }
        
        // Encontrar centro del cluster
        let sumX = 0, sumY = 0;
        for (const hex of cluster.hexes) {
            sumX += hex.x;
            sumY += hex.y;
        }
        const centerX = Math.round(sumX / cluster.hexes.length);
        const centerY = Math.round(sumY / cluster.hexes.length);
        
        // Intentar colocar UN grupo mega7 en el centro del lago
        // Ordenar hexes por distancia al centro
        const sortedHexes = [...cluster.hexes].sort((a, b) => {
            const distA = Math.abs(a.x - centerX) + Math.abs(a.y - centerY);
            const distB = Math.abs(b.x - centerX) + Math.abs(b.y - centerY);
            return distA - distB;
        });
        
        // Solo colocar un grupo mega7 por lago
        for (const hex of sortedHexes) {
            const key = `${hex.x},${hex.y}`;
            if (!available.has(key)) continue;
            
            // Elegir un grupo mega7 aleatorio
            const [groupId, group] = mega7Groups[Math.floor(Math.random() * mega7Groups.length)];
            
            if (this.canPlaceGroup(hex.x, hex.y, group, available)) {
                this.placeGroup(hex.x, hex.y, group, groupId, available, hexMap);
                return; // Solo un grupo por lago
            }
        }
    }
    
    /**
     * Rellena terreno (clear) con grupos mega7 espaciados uniformemente
     */
    fillTerrainWithMegaGroups(cluster, available, hexMap, matchingGroups) {
        // El grupo mega7 tiene 7 tiles en patrón hexagonal
        // Queremos colocarlos espaciados cada ~4 hexes para cubrir más área
        
        const mega7Group = matchingGroups.find(([id, g]) => g.tiles.length === 7);
        if (!mega7Group) {
            this.fillClusterStandard(cluster, available, hexMap, matchingGroups);
            return;
        }
        
        const [groupId, group] = mega7Group;
        
        // Calcular posiciones de inicio para grid de grupos mega7
        // Espaciado de 4 hexes en X y 3 en Y para que no se superpongan
        const spacingX = 4;
        const spacingY = 3;
        
        // Encontrar bounds del cluster
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const hex of cluster.hexes) {
            minX = Math.min(minX, hex.x);
            maxX = Math.max(maxX, hex.x);
            minY = Math.min(minY, hex.y);
            maxY = Math.max(maxY, hex.y);
        }
        
        // Colocar grupos en patrón de cuadrícula con algo de variación
        for (let y = minY; y <= maxY; y += spacingY) {
            for (let x = minX; x <= maxX; x += spacingX) {
                // Añadir variación para que no sea perfectamente regular
                const varX = x + Math.floor(Math.random() * 2);
                const varY = y + Math.floor(Math.random() * 2);
                
                if (this.canPlaceGroup(varX, varY, group, available)) {
                    this.placeGroup(varX, varY, group, groupId, available, hexMap);
                }
            }
        }
        
        // Intentar colocar más grupos en espacios que quedaron
        // (segunda pasada para llenar huecos)
        const sortedHexes = [...cluster.hexes].sort((a, b) => {
            if (a.y !== b.y) return a.y - b.y;
            return a.x - b.x;
        });
        
        for (const hex of sortedHexes) {
            const key = `${hex.x},${hex.y}`;
            if (!available.has(key)) continue;
            
            if (this.canPlaceGroup(hex.x, hex.y, group, available)) {
                this.placeGroup(hex.x, hex.y, group, groupId, available, hexMap);
            }
        }
    }
    
    /**
     * Relleno estándar para clusters (usado por bosques, agua, etc.)
     */
    fillClusterStandard(cluster, available, hexMap, matchingGroups) {
        // Ordenar hexes del cluster para procesamiento sistemático
        const sortedHexes = [...cluster.hexes].sort((a, b) => {
            if (a.y !== b.y) return a.y - b.y;
            return a.x - b.x;
        });
        
        for (const hex of sortedHexes) {
            const key = `${hex.x},${hex.y}`;
            if (!available.has(key)) continue; // Ya usado por otro grupo
            
            // Intentar colocar grupos de mayor a menor tamaño
            for (const [groupId, group] of matchingGroups) {
                if (this.canPlaceGroup(hex.x, hex.y, group, available)) {
                    this.placeGroup(hex.x, hex.y, group, groupId, available, hexMap);
                    break;
                }
            }
        }
    }
    
    /**
     * Verifica si un grupo puede colocarse en la posición dada
     * Los offsets se aplican directamente como coordenadas de grid [x+dx, y+dy]
     */
    canPlaceGroup(x, y, group, available) {
        if (!group.offsets || group.offsets.length === 0) return false;
        
        for (const [dx, dy] of group.offsets) {
            const nx = x + dx;
            const ny = y + dy;
            const key = `${nx},${ny}`;
            
            if (!this.isValid(nx, ny)) return false;
            if (!available.has(key)) return false;
        }
        
        return true;
    }
    
    /**
     * Coloca un grupo de tiles en la posición especificada
     * Usa el array 'tiles' del grupo para obtener los nombres correctos
     * Los offsets se aplican directamente como coordenadas de grid
     */
    placeGroup(x, y, group, groupId, available, hexMap) {
        const baseHex = hexMap[`${x},${y}`];
        const baseElevation = baseHex ? baseHex.elevation : 0;
        
        for (let i = 0; i < group.offsets.length; i++) {
            const [dx, dy] = group.offsets[i];
            const nx = x + dx;
            const ny = y + dy;
            const key = `${nx},${ny}`;
            
            if (this.isValid(nx, ny)) {
                // IMPORTANTE: Usar group.tiles[i] para obtener el nombre correcto del tile
                const tileName = group.tiles[i];
                
                this.tileAssignments[ny][nx] = {
                    tileId: `bt_${tileName}`,
                    groupId: groupId,
                    groupIndex: i,
                    isCenter: i === 0,
                    elevation: baseElevation
                };
                available.delete(key);
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
            'water_lake': ['water_lake'],
            'water_river': ['water_river'],
            'water': ['water', 'water_lake', 'water_river'],
            'rough': ['rough'],
            'rubble': ['rubble'],
            'urban': ['urban'],
            'hazards': ['hazards']
        };
        
        const validCategories = compatible[terrainCategory] || [];
        return validCategories.includes(groupCategory);
    }
    
    assignSingleTiles() {
        // Mapeo de terreno a tiles SOLO individuales (sin sufijo _X son singles)
        const terrainToSingles = {
            'clear': ['11'],
            'woods': ['11'],
            'woods_heavy': ['11'],
            'water': ['27'],
            'water_lake': ['27'],
            'water_depth0': ['27'],
            'rough': ['59', '60', '61', '62', '63', '64', '65', '66'],
            'rubble': ['67', '68', '69', '70'],
            'urban': ['40', '41', '42', '43', '44', '45'],
            'hazards': ['71', '72', '73', '74']
        };
        
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.width; x++) {
                if (this.tileAssignments[y][x]) continue; // Ya asignado por grupo
                
                const terrain = this.terrainMap[y][x];
                
                // Para ríos, usar tile según dirección del flujo
                if (terrain === 'water_river') {
                    const riverTile = this.getRiverTileForDirection(x, y);
                    this.tileAssignments[y][x] = {
                        tileId: riverTile,
                        elevation: this.elevationMap[y][x]
                    };
                    continue;
                }
                
                const tiles = terrainToSingles[terrain] || terrainToSingles['clear'];
                const tileNum = tiles[Math.floor(Math.random() * tiles.length)];
                
                this.tileAssignments[y][x] = {
                    tileId: `bt_${tileNum}`,
                    elevation: this.elevationMap[y][x]
                };
            }
        }
    }
    
    /**
     * Determina el tile de río correcto según la dirección del flujo
     * 
     * Lados del hexágono (flat-top, sentido horario desde arriba):
     *   0 = N (arriba)
     *   1 = NE (arriba-derecha)
     *   2 = SE (abajo-derecha)
     *   3 = S (abajo)
     *   4 = SW (abajo-izquierda)
     *   5 = NW (arriba-izquierda)
     * 
     * Tiles disponibles (singles):
     * - 27: Lados 0-3 (N a S) - recto vertical
     * - 28: Lados 1-3 (NE a S) - curva
     * - 29: Lados 0-2 (N a SE) - curva
     * - 30: Lados 2-5 (SE a NW) - diagonal con puente
     * - 31_0: Lados 2-4 (SE a SW)
     * - 31_1: Lados 3-5 (S a NW)
     * - 32_0: Lados 2-5 (SE a NW)
     * - 32_1: Lados 1-5 (NE a NW)
     */
    getRiverTileForDirection(x, y) {
        const key = `${x},${y}`;
        const dirs = this.riverDirections?.[key];
        
        if (!dirs) {
            return 'bt_27'; // Default: río vertical
        }
        
        const { from, to } = dirs;
        
        // Convertir direcciones a lados del hex
        const dirToSide = {
            'N': 0,
            'NE': 1,
            'SE': 2,
            'S': 3,
            'SW': 4,
            'NW': 5
        };
        
        const fromSide = dirToSide[from] ?? 0;
        const toSide = dirToSide[to] ?? 3;
        
        // Crear clave ordenada para buscar el tile
        const sides = [fromSide, toSide].sort((a, b) => a - b);
        const sideKey = `${sides[0]}-${sides[1]}`;
        
        // Mapeo completo de combinación de lados a tile
        // Cada combinación tiene su tile exacto o el más cercano
        const sideToTile = {
            // Tiles exactos
            '0-3': 'bt_27',    // N a S - recto vertical
            '1-3': 'bt_28',    // NE a S - curva
            '0-2': 'bt_29',    // N a SE - curva
            '2-5': 'bt_32_0',  // SE a NW (o bt_30 con puente)
            '2-4': 'bt_31_0',  // SE a SW
            '3-5': 'bt_31_1',  // S a NW
            '1-5': 'bt_32_1',  // NE a NW
            
            // Combinaciones aproximadas (espejadas o similares)
            '0-4': 'bt_28',    // N a SW ≈ espejo de NE a S (28)
            '1-4': 'bt_27',    // NE a SW - diagonal a través ≈ vertical
            '0-5': 'bt_29',    // N a NW ≈ espejo de N a SE (29)
            '0-1': 'bt_29',    // N a NE ≈ curva suave
            '1-2': 'bt_31_0',  // NE a SE ≈ SE a SW espejado
            '2-3': 'bt_28',    // SE a S ≈ curva NE a S
            '3-4': 'bt_31_1',  // S a SW ≈ espejo de S a NW
            '4-5': 'bt_32_1',  // SW a NW ≈ espejo de NE a NW
        };
        
        const tile = sideToTile[sideKey];
        console.log(`River tile at ${x},${y}: from=${from}(${fromSide}) to=${to}(${toSide}) key=${sideKey} -> ${tile}`);
        
        return tile || 'bt_27';
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
