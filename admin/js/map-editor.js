/**
 * MesaRPG - Editor de Mapas
 * Permite crear, editar y guardar mapas para el juego
 */

class MapEditor {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.tiles = {};
        this.categories = {};
        this.tileImages = {}; // Cache de imágenes de tiles
        this.currentMap = null;
        this.selectedTile = null;
        this.mapWidth = 20;
        this.mapHeight = 15;
        this.tileSize = 40;
        this.gridType = 'square'; // 'square' o 'hex'
        
        // Sistema de juego actual
        this.gameSystem = null;
        this.distanceUnit = 'casillas';
        this.distancePerCell = 1;
        
        // Herramientas
        this.currentTool = 'paint'; // 'paint', 'erase', 'fill', 'select'
        this.brushSize = 1;
        
        // Estado del editor
        this.isMouseDown = false;
        this.lastPaintedCell = null;
        this.undoStack = [];
        this.redoStack = [];
        this.maxUndoSteps = 50;
        
        // Capas
        this.layers = ['terrain', 'objects', 'effects'];
        this.currentLayer = 'terrain';
        this.layerVisibility = { terrain: true, objects: true, effects: true };
        
        // Opciones de visualización
        this.showHexBorders = false; // Bordes de hexágono desactivados por defecto
        
        this.init();
    }
    
    async init() {
        await this.loadGameSystemConfig();
        
        // Si no hay sistema seleccionado, mostrar mensaje y no continuar
        if (!this.systemId || this.systemId === 'none') {
            this.showNoSystemMessage();
            return;
        }
        
        // Restaurar el canvas si fue reemplazado por el mensaje
        this.restoreCanvas();
        
        await this.loadTileLibrary();
        await this.preloadTileImages();
        this.setupUI();
        this.createNewMap(this.mapWidth, this.mapHeight);
        
        // Actualizar opciones del generador
        updateMapTypeSelector(this.systemId);
    }
    
    restoreCanvas() {
        const container = document.querySelector('.map-canvas-container');
        if (!container) return;
        
        // Si no hay canvas, recrearlo
        let canvas = container.querySelector('#map-canvas');
        if (!canvas) {
            console.log('🔧 Restaurando canvas...');
            container.innerHTML = '<canvas id="map-canvas"></canvas>';
        }
        
        // Forzar re-setup del canvas
        this.canvas = null;
        this.ctx = null;
        this.setupCanvas();
    }
    
    showNoSystemMessage() {
        const container = document.querySelector('.map-canvas-container');
        if (container) {
            container.innerHTML = `
                <div class="no-system-message" style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                    color: #888;
                    text-align: center;
                    padding: 40px;
                ">
                    <span style="font-size: 48px; margin-bottom: 16px;">🎮</span>
                    <h3 style="margin: 0 0 8px 0; color: #aaa;">Selecciona un Sistema de Juego</h3>
                    <p style="margin: 0; font-size: 14px;">Usa el botón "Cambiar Juego" en la barra superior para elegir BattleTech, D&D u otro sistema.</p>
                </div>
            `;
        }
        
        // Deshabilitar paleta de tiles
        const palette = document.getElementById('tile-palette');
        if (palette) {
            palette.innerHTML = '<p class="empty-state">Selecciona un sistema de juego primero</p>';
        }
    }
    
    async loadGameSystemConfig() {
        try {
            const response = await fetch('/api/state');
            const state = await response.json();
            this.systemId = state.game_system_id || state.game_system || null;
            
            if (!this.systemId) {
                console.log('⚠️ No hay sistema de juego seleccionado');
                return;
            }
            
            const sysResponse = await fetch(`/api/systems/${this.systemId}`);
            if (sysResponse.ok) {
                this.gameSystem = await sysResponse.json();
                this.gridType = this.gameSystem.gridType || this.gameSystem.grid?.type || 'square';
                this.tileSize = this.gameSystem.gridSize || this.gameSystem.grid?.cellSize || 40;
                this.distanceUnit = this.gameSystem.distanceUnit || 'casillas';
                this.distancePerCell = this.gameSystem.distancePerSquare || 1;
                console.log(`🎮 Sistema: ${this.gameSystem.name}, Grid: ${this.gridType}, Tamaño: ${this.tileSize}px`);
            }
        } catch (error) {
            console.warn('No se pudo cargar config del sistema');
            this.systemId = null;
        }
    }
    
    async loadTileLibrary() {
        try {
            // Intentar cargar tiles específicos del sistema primero
            let response = await fetch(`/api/tiles/${this.systemId}`);
            if (!response.ok) {
                // Fallback a tiles genéricos
                response = await fetch('/api/tiles');
            }
            const data = await response.json();
            this.tiles = data.tiles || {};
            this.categories = data.categories || {};
            this.layerSystem = data.layerSystem || false;
            this.layersConfig = data.layers || {};
            
            // Si el sistema usa capas, configurarlas
            if (this.layerSystem) {
                this.layers = Object.keys(this.layersConfig);
                this.currentLayer = this.layers[0] || 'terrain';
            }
            
            // Detectar si es BattleTech y configurar grid hexagonal
            if (data.gridType === 'hex' || data.system === 'battletech' || this.systemId === 'battletech') {
                this.gridType = 'hex';
                console.log('🔷 Modo hexagonal activado');
            }
            
            console.log(`📦 Cargados ${Object.keys(this.tiles).length} tiles para ${this.systemId}`);
            if (this.layerSystem) {
                console.log(`📚 Sistema de capas activo: ${this.layers.join(', ')}`);
            }
        } catch (error) {
            console.error('Error cargando tiles:', error);
            // Tiles por defecto si falla la carga
            this.tiles = {
                grass: { id: 'grass', name: 'Hierba', color: '#4a7c23', icon: '🟩', movementCost: 1, blocksVision: false },
                wall_stone: { id: 'wall_stone', name: 'Muro', color: '#5d6d7e', icon: '🧱', movementCost: 999, blocksVision: true }
            };
        }
    }
    
    async preloadTileImages() {
        /**
         * Precarga imágenes de tiles - versión optimizada
         * Solo precarga las primeras de cada categoría, el resto se carga bajo demanda
         */
        console.log('🖼️ Preparando carga de imágenes...');
        
        // Solo precargar unos pocos tiles esenciales
        const essentialTiles = ['bt_11', 'grass', 'wall_stone'];
        const loadPromises = [];
        
        for (const tileId of essentialTiles) {
            const tile = this.tiles[tileId];
            if (tile?.file) {
                const promise = this.loadTileImage(tileId, tile.file);
                loadPromises.push(promise);
            }
        }
        
        await Promise.all(loadPromises);
        console.log(`✅ Imágenes esenciales cargadas, resto se carga bajo demanda`);
    }
    
    loadTileImage(tileId, filePath) {
        return new Promise((resolve) => {
            if (this.tileImages[tileId]) {
                resolve(this.tileImages[tileId]);
                return;
            }
            
            const img = new Image();
            img.onload = () => {
                this.tileImages[tileId] = img;
                resolve(img);
            };
            img.onerror = () => {
                // console.warn(`No se pudo cargar: ${filePath}`);
                resolve(null);
            };
            img.src = filePath;
        });
    }
    
    getTileImage(tileId) {
        // Si ya está cargada, devolverla
        if (this.tileImages[tileId]) {
            return this.tileImages[tileId];
        }
        
        // Cargar bajo demanda (async, no bloquea)
        const tile = this.tiles[tileId];
        if (tile?.file) {
            this.loadTileImage(tileId, tile.file).then(() => {
                // Re-renderizar cuando cargue
                if (this.renderPending) return;
                this.renderPending = true;
                requestAnimationFrame(() => {
                    this.renderPending = false;
                    this.render();
                });
            });
        }
        
        return null;
    }
    
    setupUI() {
        this.renderTilePalette();
        this.setupCanvas();
        this.setupToolbar();
        this.setupEventListeners();
    }
    
    renderTilePalette() {
        const palette = document.getElementById('tile-palette');
        if (!palette) return;
        
        let html = '';
        
        // Si hay sistema de capas, mostrar selector
        if (this.layerSystem && Object.keys(this.layersConfig).length > 0) {
            html += '<div class="layer-selector">';
            html += '<label>Capa activa:</label>';
            html += '<select id="layer-select" onchange="mapEditor.setCurrentLayer(this.value)">';
            Object.entries(this.layersConfig).forEach(([layerId, layerData]) => {
                html += `<option value="${layerId}" ${this.currentLayer === layerId ? 'selected' : ''}>${layerData.name}</option>`;
            });
            html += '</select>';
            html += '</div>';
        }
        
        html += '<div class="palette-categories">';
        
        // Agrupar tiles por categoría
        const tilesByCategory = {};
        Object.values(this.tiles).forEach(tile => {
            const cat = tile.category || 'other';
            if (!tilesByCategory[cat]) tilesByCategory[cat] = [];
            tilesByCategory[cat].push(tile);
        });
        
        // Renderizar cada categoría
        Object.entries(this.categories).forEach(([catId, catData]) => {
            const tilesInCat = tilesByCategory[catId] || [];
            if (tilesInCat.length === 0) return;
            
            // Si hay capas, filtrar por capa actual
            const filteredTiles = this.layerSystem 
                ? tilesInCat.filter(t => !t.layer || t.layer === this.currentLayer || catData.layer === this.currentLayer)
                : tilesInCat;
            
            if (filteredTiles.length === 0) return;
            
            // Generar tooltip con info detallada para BattleTech
            const getTileTooltip = (tile) => {
                let tooltip = tile.name;
                if (tile.movementCost !== undefined) tooltip += `\nMov: ${tile.movementCost === 999 ? '∞' : tile.movementCost}`;
                if (tile.defenseBonus) tooltip += `\nDef: +${tile.defenseBonus}`;
                if (tile.toHitModifier) tooltip += `\n+${tile.toHitModifier} impacto`;
                if (tile.providesCover) tooltip += `\nCobertura: ${tile.providesCover}`;
                if (tile.elevation) tooltip += `\nElevación: +${tile.elevation}`;
                if (tile.blocksLOS || tile.blocksVision) tooltip += `\nBloquea visión`;
                if (tile.heatDissipation) tooltip += `\nDisipa calor: ${tile.heatDissipation}`;
                if (tile.explosive) tooltip += `\n⚠️ EXPLOSIVO`;
                return tooltip;
            };
            
            // Obtener preview - usar thumbnail o imagen
            const getTilePreview = (tile) => {
                if (tile.thumbnail) {
                    return `<img src="${tile.thumbnail}" alt="${tile.name}" class="tile-thumb">`;
                } else if (tile.file) {
                    return `<img src="${tile.file}" alt="${tile.name}" class="tile-thumb">`;
                }
                return `<div class="tile-color" style="background-color: ${tile.color || '#666'}">${tile.icon || ''}</div>`;
            };
            
            html += `
                <div class="palette-category" data-category="${catId}">
                    <div class="category-header" onclick="mapEditor.toggleCategory('${catId}')">
                        <span class="category-icon">${catData.icon}</span>
                        <span class="category-name">${catData.name}</span>
                        <span class="category-count">(${filteredTiles.length})</span>
                        <span class="category-toggle">▼</span>
                    </div>
                    <div class="category-tiles" id="cat-${catId}">
                        ${filteredTiles.map(tile => `
                            <div class="tile-item ${this.selectedTile?.id === tile.id ? 'selected' : ''}" 
                                 data-tile-id="${tile.id}"
                                 title="${getTileTooltip(tile)}"
                                 onclick="mapEditor.selectTile('${tile.id}')">
                                <div class="tile-preview">
                                    ${getTilePreview(tile)}
                                </div>
                                <span class="tile-name">${tile.name}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        });
        
        html += '</div>';
        palette.innerHTML = html;
    }
    
    setCurrentLayer(layerId) {
        this.currentLayer = layerId;
        console.log(`📚 Capa activa: ${layerId}`);
        this.renderTilePalette();
    }
    
    toggleCategory(catId) {
        const catTiles = document.getElementById(`cat-${catId}`);
        if (catTiles) {
            catTiles.classList.toggle('collapsed');
        }
    }
    
    selectTile(tileId) {
        this.selectedTile = this.tiles[tileId];
        
        // Actualizar UI
        document.querySelectorAll('.tile-item').forEach(el => {
            el.classList.toggle('selected', el.dataset.tileId === tileId);
        });
        
        // Mostrar info del tile
        this.showTileInfo(this.selectedTile);
    }
    
    showTileInfo(tile) {
        const infoPanel = document.getElementById('tile-info');
        if (!infoPanel || !tile) return;
        
        infoPanel.innerHTML = `
            <h4>${tile.icon} ${tile.name}</h4>
            <div class="tile-stats">
                <div class="stat"><span>Movimiento:</span> <strong>${tile.movementCost === 999 ? '∞' : tile.movementCost}</strong></div>
                <div class="stat"><span>Bloquea visión:</span> <strong>${tile.blocksVision ? '✓' : '✗'}</strong></div>
                <div class="stat"><span>Transitable:</span> <strong>${tile.isWalkable !== false ? '✓' : '✗'}</strong></div>
                ${tile.damage ? `<div class="stat danger"><span>Daño:</span> <strong>${tile.damage} (${tile.damageType})</strong></div>` : ''}
                ${tile.providesCover ? `<div class="stat"><span>Cobertura:</span> <strong>${tile.providesCover}</strong></div>` : ''}
            </div>
            <p class="tile-description">${tile.description || ''}</p>
        `;
    }
    
    setupCanvas() {
        this.canvas = document.getElementById('map-canvas');
        if (!this.canvas) {
            console.warn('❌ Canvas no encontrado');
            return;
        }
        
        this.ctx = this.canvas.getContext('2d');
        this.resizeCanvas();
    }
    
    resizeCanvas() {
        if (!this.canvas) {
            console.warn('❌ No hay canvas para redimensionar');
            return;
        }
        
        const container = this.canvas.parentElement;
        let maxWidth = container?.clientWidth - 20 || 600;
        let maxHeight = container?.clientHeight - 20 || 400;
        
        // Asegurar tamaño mínimo
        maxWidth = Math.max(maxWidth, 400);
        maxHeight = Math.max(maxHeight, 300);
        
        if (this.gridType === 'hex') {
            // Para hexágonos flat-top
            // hexWidth = 2 * size, hexHeight = sqrt(3) * size
            // horizSpacing = hexWidth * 0.75 = 1.5 * size
            // Columnas impares desplazadas hacia abajo por hexHeight/2
            
            // Ancho total = horizSpacing * (mapWidth - 1) + hexWidth
            // maxWidth = 1.5 * (tileSize/2) * (mapWidth - 1) + tileSize
            // maxWidth = tileSize * (0.75 * (mapWidth - 1) + 1)
            // maxWidth = tileSize * (0.75 * mapWidth + 0.25)
            // tileSize = maxWidth / (0.75 * mapWidth + 0.25)
            
            const tileFromWidth = maxWidth / (0.75 * this.mapWidth + 0.25);
            
            // Alto total = hexHeight * mapHeight + hexHeight/2 (para columnas impares)
            // maxHeight = sqrt(3) * (tileSize/2) * mapHeight + sqrt(3) * (tileSize/4)
            // maxHeight = sqrt(3) * tileSize * (mapHeight + 0.5) / 2
            // tileSize = maxHeight * 2 / (sqrt(3) * (mapHeight + 0.5))
            
            const tileFromHeight = (maxHeight * 2) / (Math.sqrt(3) * (this.mapHeight + 0.5));
            
            this.tileSize = Math.min(tileFromWidth, tileFromHeight, 60);
            this.tileSize = Math.max(this.tileSize, 20); // Mínimo 20px para hex
            
            // Calcular dimensiones reales del canvas
            const size = this.tileSize / 2;
            const hexWidth = size * 2;
            const hexHeight = Math.sqrt(3) * size;
            const horizSpacing = hexWidth * 0.75;
            
            this.canvas.width = horizSpacing * (this.mapWidth - 1) + hexWidth;
            this.canvas.height = hexHeight * (this.mapHeight + 0.5);
        } else {
            // Grid cuadrado
            const tileW = Math.floor(maxWidth / this.mapWidth);
            const tileH = Math.floor(maxHeight / this.mapHeight);
            this.tileSize = Math.min(tileW, tileH, 48);
            this.tileSize = Math.max(this.tileSize, 16);
            
            this.canvas.width = this.mapWidth * this.tileSize;
            this.canvas.height = this.mapHeight * this.tileSize;
        }
        
        this.render();
    }
    
    setupToolbar() {
        // Los botones ya están en el HTML, solo conectamos eventos
    }
    
    setupEventListeners() {
        if (!this.canvas) return;
        
        // Mouse events
        this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.canvas.addEventListener('mouseup', () => this.onMouseUp());
        this.canvas.addEventListener('mouseleave', () => this.onMouseUp());
        
        // Touch events para móvil/tablet
        this.canvas.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            this.onMouseDown({ clientX: touch.clientX, clientY: touch.clientY });
        });
        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            this.onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
        });
        this.canvas.addEventListener('touchend', () => this.onMouseUp());
        
        // Teclado
        document.addEventListener('keydown', (e) => this.onKeyDown(e));
        
        // Resize
        window.addEventListener('resize', () => this.resizeCanvas());
    }
    
    getGridCoords(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        if (this.gridType === 'hex') {
            return this.getHexCoords(mouseX, mouseY);
        } else {
            return this.getSquareCoords(mouseX, mouseY);
        }
    }
    
    getSquareCoords(mouseX, mouseY) {
        const gridX = Math.floor(mouseX / this.tileSize);
        const gridY = Math.floor(mouseY / this.tileSize);
        return { x: gridX, y: gridY };
    }
    
    getHexCoords(mouseX, mouseY) {
        // Hexágonos flat-top
        const size = this.tileSize / 2; // Radio del hexágono
        const hexWidth = size * 2;
        const hexHeight = Math.sqrt(3) * size;
        const horizSpacing = hexWidth * 0.75;
        
        // Estimación inicial de columna
        const roughX = Math.floor(mouseX / horizSpacing);
        const offsetY = (roughX % 2 === 1) ? hexHeight / 2 : 0;
        const roughY = Math.floor((mouseY - offsetY) / hexHeight);
        
        // Verificar hex más cercano entre candidatos
        let bestDist = Infinity;
        let bestX = roughX;
        let bestY = roughY;
        
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const testX = roughX + dx;
                const testY = roughY + dy;
                if (testY < 0 || testX < 0) continue;
                
                const testOffset = (testX % 2 === 1) ? hexHeight / 2 : 0;
                const cx = testX * horizSpacing + size;
                const cy = testOffset + testY * hexHeight + hexHeight / 2;
                const dist = Math.sqrt((mouseX - cx) ** 2 + (mouseY - cy) ** 2);
                if (dist < bestDist) {
                    bestDist = dist;
                    bestX = testX;
                    bestY = testY;
                }
            }
        }
        
        return { x: bestX, y: bestY };
    }
    
    onMouseDown(e) {
        this.isMouseDown = true;
        this.saveUndoState();
        this.handleTool(e);
    }
    
    onMouseMove(e) {
        if (!this.isMouseDown) {
            // Mostrar preview
            this.showCursorPreview(e);
            return;
        }
        this.handleTool(e);
    }
    
    onMouseUp() {
        this.isMouseDown = false;
        this.lastPaintedCell = null;
    }
    
    showCursorPreview(e) {
        const coords = this.getGridCoords(e);
        // Podemos mostrar un preview del tile actual
        this.render();
        if (this.selectedTile && this.currentTool === 'paint') {
            this.ctx.globalAlpha = 0.5;
            this.drawTile(coords.x, coords.y, this.selectedTile);
            this.ctx.globalAlpha = 1;
        }
    }
    
    handleTool(e) {
        const coords = this.getGridCoords(e);
        
        // Evitar pintar la misma celda repetidamente
        if (this.lastPaintedCell && 
            this.lastPaintedCell.x === coords.x && 
            this.lastPaintedCell.y === coords.y) {
            return;
        }
        this.lastPaintedCell = coords;
        
        switch (this.currentTool) {
            case 'paint':
                this.paintTile(coords.x, coords.y);
                break;
            case 'erase':
                this.eraseTile(coords.x, coords.y);
                break;
            case 'fill':
                this.floodFill(coords.x, coords.y);
                break;
            case 'eyedropper':
                this.pickTile(coords.x, coords.y);
                break;
        }
        
        this.render();
    }
    
    onKeyDown(e) {
        // Atajos de teclado
        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 'z':
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.redo();
                    } else {
                        this.undo();
                    }
                    break;
                case 'y':
                    e.preventDefault();
                    this.redo();
                    break;
                case 's':
                    e.preventDefault();
                    this.saveMap();
                    break;
            }
        } else {
            switch (e.key.toLowerCase()) {
                case 'p':
                    this.setTool('paint');
                    break;
                case 'e':
                    this.setTool('erase');
                    break;
                case 'f':
                    this.setTool('fill');
                    break;
                case 'i':
                    this.setTool('eyedropper');
                    break;
            }
        }
    }
    
    // === Operaciones de Mapa ===
    
    createNewMap(width, height, fillTile = null) {
        this.mapWidth = width;
        this.mapHeight = height;
        
        // Seleccionar tile de relleno según el sistema
        if (!fillTile) {
            fillTile = this.systemId === 'battletech' ? 'bt_11' : 'grass';
        }
        
        // Configurar capas según el sistema
        const mapLayers = {};
        if (this.layerSystem && this.layers.length > 0) {
            this.layers.forEach(layerName => {
                mapLayers[layerName] = this.createEmptyLayer(width, height, layerName === 'terrain' ? fillTile : null);
            });
        } else {
            mapLayers.terrain = this.createEmptyLayer(width, height, fillTile);
            mapLayers.objects = this.createEmptyLayer(width, height, null);
            mapLayers.effects = this.createEmptyLayer(width, height, null);
        }
        
        this.currentMap = {
            id: 'map_' + Date.now(),
            name: 'Nuevo Mapa',
            width: width,
            height: height,
            gridType: this.gridType,
            systemId: this.systemId,
            created: new Date().toISOString(),
            layers: mapLayers,
            metadata: {
                author: 'GM',
                description: ''
            }
        };
        
        this.undoStack = [];
        this.redoStack = [];
        
        this.resizeCanvas();
        this.render();
        
        // Marcar que hay mapa para ocultar mensaje
        document.querySelector('.map-canvas-container')?.classList.add('has-map');
        
        console.log(`🗺️ Nuevo mapa creado: ${width}x${height}`);
    }
    
    createEmptyLayer(width, height, fillTile) {
        const layer = [];
        for (let y = 0; y < height; y++) {
            const row = [];
            for (let x = 0; x < width; x++) {
                row.push(fillTile ? { tileId: fillTile } : null);
            }
            layer.push(row);
        }
        return layer;
    }
    
    /**
     * Obtiene los vecinos de un hexágono en grid flat-top
     * Devuelve las 6 celdas adyacentes
     */
    getHexNeighbors(x, y) {
        // Para hex flat-top, las columnas pares e impares tienen offsets diferentes
        const isOddCol = (x % 2) === 1;
        
        if (isOddCol) {
            // Columna impar (desplazada hacia abajo)
            return [
                { x: x - 1, y: y     }, // 0: arriba-izq
                { x: x - 1, y: y + 1 }, // 1: abajo-izq
                { x: x,     y: y - 1 }, // 2: arriba
                { x: x,     y: y + 1 }, // 3: abajo
                { x: x + 1, y: y     }, // 4: arriba-der
                { x: x + 1, y: y + 1 }, // 5: abajo-der
            ];
        } else {
            // Columna par
            return [
                { x: x - 1, y: y - 1 }, // 0: arriba-izq
                { x: x - 1, y: y     }, // 1: abajo-izq
                { x: x,     y: y - 1 }, // 2: arriba
                { x: x,     y: y + 1 }, // 3: abajo
                { x: x + 1, y: y - 1 }, // 4: arriba-der
                { x: x + 1, y: y     }, // 5: abajo-der
            ];
        }
    }
    
    /**
     * Obtiene las celdas que ocupa un multi-tile según su forma
     * Para grid flat-top, los vecinos son:
     * - 0: arriba-izq (x-1)
     * - 1: abajo-izq (x-1)  
     * - 2: arriba (mismo x, y-1)
     * - 3: abajo (mismo x, y+1)
     * - 4: arriba-der (x+1)
     * - 5: abajo-der (x+1)
     */
    getMultiTileCells(tile, x, y) {
        const shape = tile.shape || 'single';
        const hexCount = tile.hexCount || 1;
        
        if (hexCount <= 1) {
            return [{ x, y }];
        }
        
        const neighbors = this.getHexNeighbors(x, y);
        const cells = [{ x, y, isCenter: true }]; // Siempre incluir el centro/origen
        const isOddCol = (x % 2) === 1;
        
        // Helper para obtener el vecino "horizontal" derecho alineado
        const getRightNeighbor = (col, row) => {
            // En flat-top, al ir a la columna siguiente, si cambiamos de paridad
            // necesitamos ajustar y para mantener alineación visual
            if (col % 2 === 0) {
                // De par a impar: el vecino alineado es (col+1, row)
                return { x: col + 1, y: row };
            } else {
                // De impar a par: el vecino alineado es (col+1, row-1) para alinear arriba
                // o (col+1, row) para alinear abajo
                return { x: col + 1, y: row };
            }
        };
        
        switch (shape) {
            case 'mega': // 7 hex - centro + 6 vecinos
                neighbors.forEach(n => cells.push(n));
                break;
                
            case 'h2': // 2 hex horizontal (derecha)
                // Usar el vecino derecho que esté más alineado horizontalmente
                if (isOddCol) {
                    cells.push(neighbors[4]); // arriba-der para columna impar
                } else {
                    cells.push(neighbors[5]); // abajo-der para columna par
                }
                break;
                
            case 'v2': // 2 hex vertical (abajo)
                cells.push({ x, y: y + 1 }); // Directamente abajo en la misma columna
                break;
                
            case 'tri_down': // 3 hex triángulo hacia abajo (punta abajo)
                // Forma de V invertida:
                //    *        <- centro (el hex clickeado)
                //   / \
                //  *   *      <- abajo-izq y abajo-der
                cells.push(neighbors[1]); // abajo-izq
                cells.push(neighbors[5]); // abajo-der
                break;
                
            case 'h2v2': // 4 hex (2x2) - 2 columnas, 2 filas
                // Para flat-top, 2x2 significa:
                // - 2 hexes en la columna actual (centro + abajo)
                // - 2 hexes en la columna de al lado
                cells.push({ x, y: y + 1 }); // abajo del centro
                // La columna derecha depende de la paridad
                // neighbors[4] = arriba-der, neighbors[5] = abajo-der
                cells.push(neighbors[4]); // der arriba (alineado con centro)
                cells.push(neighbors[5]); // der abajo
                break;
                
            case 'v3': // 3 hex vertical
                cells.push({ x, y: y + 1 });
                cells.push({ x, y: y + 2 });
                break;
                
            case 'v4': // 4 hex vertical
                cells.push({ x, y: y + 1 });
                cells.push({ x, y: y + 2 });
                cells.push({ x, y: y + 3 });
                break;
                
            case 'h2v3': // 5 hex (2 columnas x 3 filas, forma escalonada)
                // Columna izquierda (actual): centro + 2 abajo = 3 hexes
                cells.push({ x, y: y + 1 });
                cells.push({ x, y: y + 2 });
                // Columna derecha: 2 hexes alineados
                if (isOddCol) {
                    // De impar a par: los hexes de la derecha se alinean "arriba"
                    cells.push({ x: x + 1, y: y });     // alineado con centro
                    cells.push({ x: x + 1, y: y + 1 }); // alineado con y+1
                } else {
                    // De par a impar: los hexes de la derecha se alinean "abajo"
                    cells.push({ x: x + 1, y: y + 1 }); // alineado con y+1
                    cells.push({ x: x + 1, y: y + 2 }); // alineado con y+2
                }
                break;
                
            case 'h3v2': // 6 hex (3 columnas x 2 filas)
                // Fila superior: centro ya está, añadir izq y der
                // Fila inferior: 3 hexes debajo
                
                // Izquierda de la fila superior
                if (isOddCol) {
                    cells.push({ x: x - 1, y: y });     // izq-arriba
                    cells.push({ x: x - 1, y: y + 1 }); // izq-abajo
                } else {
                    cells.push({ x: x - 1, y: y });     // izq-arriba
                    cells.push({ x: x - 1, y: y + 1 }); // izq-abajo
                }
                
                // Centro abajo
                cells.push({ x, y: y + 1 });
                
                // Derecha
                if (isOddCol) {
                    cells.push({ x: x + 1, y: y });     // der-arriba
                    cells.push({ x: x + 1, y: y + 1 }); // der-abajo
                } else {
                    cells.push({ x: x + 1, y: y });     // der-arriba  
                    cells.push({ x: x + 1, y: y + 1 }); // der-abajo
                }
                break;
            
            case 'h3v3': // 9 hex (3 columnas x 3 filas)
                // Para flat-top, un 3x3 tiene:
                // - Columna izquierda (x-1): 3 hexes
                // - Columna centro (x): 3 hexes (y-1, y, y+1)
                // - Columna derecha (x+1): 3 hexes
                
                // Columna centro: arriba y abajo (centro ya está)
                cells.push({ x, y: y - 1 });
                cells.push({ x, y: y + 1 });
                
                // Columna izquierda: los 3 hexes alineados
                // En flat-top, al ir a x-1, el offset depende de la paridad actual
                if (isOddCol) {
                    // x es impar, x-1 es par
                    // Columnas pares están más "arriba"
                    cells.push({ x: x - 1, y: y - 1 }); // arriba-izq
                    cells.push({ x: x - 1, y: y });     // medio-izq
                    cells.push({ x: x - 1, y: y + 1 }); // abajo-izq
                } else {
                    // x es par, x-1 es impar
                    // Columnas impares están más "abajo"
                    cells.push({ x: x - 1, y: y });     // arriba-izq
                    cells.push({ x: x - 1, y: y + 1 }); // medio-izq
                    cells.push({ x: x - 1, y: y + 2 }); // abajo-izq
                }
                
                // Columna derecha: los 3 hexes alineados
                if (isOddCol) {
                    // x es impar, x+1 es par
                    cells.push({ x: x + 1, y: y - 1 }); // arriba-der
                    cells.push({ x: x + 1, y: y });     // medio-der
                    cells.push({ x: x + 1, y: y + 1 }); // abajo-der
                } else {
                    // x es par, x+1 es impar
                    cells.push({ x: x + 1, y: y });     // arriba-der
                    cells.push({ x: x + 1, y: y + 1 }); // medio-der
                    cells.push({ x: x + 1, y: y + 2 }); // abajo-der
                }
                break;
                
            case 'h5v5': // 19 hex (hexágono de radio 2)
                // Centro (1) + Anillo 1 (6) + Anillo 2 (12) = 19
                
                // Anillo 1: los 6 vecinos directos
                neighbors.forEach(n => cells.push(n));
                
                // Anillo 2: 12 hexes en el segundo anillo
                // Arriba y abajo lejanos (misma columna)
                cells.push({ x, y: y - 2 });
                cells.push({ x, y: y + 2 });
                
                // Vecinos de cada vecino del anillo 1 que están en el anillo 2
                // Desde arriba-izq (neighbors[0])
                const n0 = this.getHexNeighbors(neighbors[0].x, neighbors[0].y);
                cells.push(n0[0]); // más arriba-izq
                cells.push(n0[2]); // arriba del arriba-izq
                
                // Desde abajo-izq (neighbors[1])
                const n1_bl = this.getHexNeighbors(neighbors[1].x, neighbors[1].y);
                cells.push(n1_bl[1]); // más abajo-izq
                cells.push(n1_bl[3]); // abajo del abajo-izq
                
                // Desde arriba-der (neighbors[4])
                const n4 = this.getHexNeighbors(neighbors[4].x, neighbors[4].y);
                cells.push(n4[4]); // más arriba-der
                cells.push(n4[2]); // arriba del arriba-der
                
                // Desde abajo-der (neighbors[5])
                const n5 = this.getHexNeighbors(neighbors[5].x, neighbors[5].y);
                cells.push(n5[5]); // más abajo-der
                cells.push(n5[3]); // abajo del abajo-der
                
                // Las 2 posiciones faltantes: izquierda y derecha lejanas
                // Desde arriba (neighbors[2]) -> su arriba-izq y arriba-der
                const n2 = this.getHexNeighbors(neighbors[2].x, neighbors[2].y);
                cells.push(n2[0]); // arriba del arriba -> izq
                cells.push(n2[4]); // arriba del arriba -> der
                break;
                
            case 'h3': // 3-4 hex línea horizontal
                // Izquierda y derecha usando vecinos
                cells.push(neighbors[0]); // arriba-izq (o abajo-izq según vista)
                cells.push(neighbors[4]); // arriba-der
                if (hexCount >= 4) {
                    const rightNeighbors = this.getHexNeighbors(neighbors[4].x, neighbors[4].y);
                    cells.push(rightNeighbors[4]);
                }
                break;
                
            case 'h5': // 5+ hex línea horizontal
                cells.push(neighbors[0]); // izq
                cells.push(neighbors[4]); // der
                // Más a la izquierda
                const leftN = this.getHexNeighbors(neighbors[0].x, neighbors[0].y);
                cells.push(leftN[0]);
                // Más a la derecha
                const rightN = this.getHexNeighbors(neighbors[4].x, neighbors[4].y);
                cells.push(rightN[4]);
                break;
                
            case 'mega13': // 13 hex - centro + anillo 1 (6) + 6 del anillo 2
                // Añadir los 6 vecinos primero (anillo 1)
                neighbors.forEach(n => cells.push(n));
                // Añadir 6 hexes del anillo 2 (en las direcciones cardinales)
                // Arriba y abajo lejanos (misma columna)
                cells.push({ x, y: y - 2 });
                cells.push({ x, y: y + 2 });
                // Para los 4 restantes, usamos los vecinos de los vecinos
                // Izquierda lejana: vecino del vecino izq
                const leftUpNeighbor = this.getHexNeighbors(neighbors[0].x, neighbors[0].y);
                cells.push(leftUpNeighbor[0]); // más arriba-izq
                cells.push(leftUpNeighbor[1]); // más abajo-izq
                // Derecha lejana: vecino del vecino der
                const rightUpNeighbor = this.getHexNeighbors(neighbors[4].x, neighbors[4].y);
                cells.push(rightUpNeighbor[4]); // más arriba-der
                cells.push(rightUpNeighbor[5]); // más abajo-der
                break;
            
            // ============ SHAPES ESPECÍFICAS PARA BOSQUES ============
            
            case 'bosque3': // 3 hex: centro + 2 a la izquierda (arriba-izq y abajo-izq)
                // Centro ya está en cells
                // Las dos de la izquierda
                cells.push(neighbors[0]); // arriba-izq
                cells.push(neighbors[1]); // abajo-izq
                break;
            
            case 'bosque_denso3': // 5 hex: 3 columna izq + 2 columna der
                // Columna izquierda tiene 3 hexes, columna derecha (donde está el centro) tiene 2
                // La columna izquierda es la más alta
                
                // Usamos neighbors que ya manejan la paridad correctamente
                cells.push(neighbors[0]); // arriba-izq
                cells.push(neighbors[1]); // medio-izq (abajo-izq del centro)
                
                // El tercer hex de la columna izquierda (debajo de neighbors[1])
                const leftMid = neighbors[1];
                cells.push({ x: leftMid.x, y: leftMid.y + 1 }); // abajo del abajo-izq
                
                // Centro abajo (segunda de la columna derecha)
                cells.push({ x, y: y + 1 });
                break;
            
            case 'bosque_denso4': // 9 hex: 3 columnas x 3 filas, centro más alto
                // El centro clickeado es el hex central de la columna del medio
                // Usamos neighbors que ya manejan la paridad correctamente
                
                // Columna centro (x): arriba y abajo del centro
                cells.push({ x, y: y - 1 }); // arriba
                cells.push({ x, y: y + 1 }); // abajo
                
                // Columna izquierda: usamos neighbors[0] (arriba-izq) como referencia
                const leftTop = neighbors[0]; // arriba-izq
                cells.push(leftTop);
                cells.push({ x: leftTop.x, y: leftTop.y + 1 }); // medio-izq
                cells.push({ x: leftTop.x, y: leftTop.y + 2 }); // abajo-izq
                
                // Columna derecha: usamos neighbors[4] (arriba-der) como referencia  
                const rightTop = neighbors[4]; // arriba-der
                cells.push(rightTop);
                cells.push({ x: rightTop.x, y: rightTop.y + 1 }); // medio-der
                cells.push({ x: rightTop.x, y: rightTop.y + 2 }); // abajo-der
                break;
                
            default:
                // Para shapes desconocidos, usar solo el centro
                console.warn(`Shape desconocido: ${shape}`);
        }
        
        return cells;
    }
    
    paintTile(x, y) {
        if (!this.selectedTile || !this.isValidCoord(x, y)) return;
        
        const layer = this.currentMap.layers[this.currentLayer];
        const tile = this.selectedTile;
        const hexCount = tile.hexCount || 1;
        
        // Multi-tile
        if (hexCount > 1 && this.gridType === 'hex') {
            const cells = this.getMultiTileCells(tile, x, y);
            
            cells.forEach((cell, idx) => {
                if (this.isValidCoord(cell.x, cell.y)) {
                    layer[cell.y][cell.x] = { 
                        tileId: tile.id,
                        rotation: 0,
                        variant: 0,
                        isMultiCenter: idx === 0,
                        isMultiPart: idx > 0,
                        multiCenterX: x,
                        multiCenterY: y,
                        hexCount: hexCount,
                        shape: tile.shape
                    };
                }
            });
        } else {
            // Tile normal - aplicar brush size
            for (let dy = 0; dy < this.brushSize; dy++) {
                for (let dx = 0; dx < this.brushSize; dx++) {
                    const px = x + dx;
                    const py = y + dy;
                    if (this.isValidCoord(px, py)) {
                        layer[py][px] = { 
                            tileId: tile.id,
                            rotation: 0,
                            variant: 0
                        };
                    }
                }
            }
        }
    }
    
    eraseTile(x, y) {
        if (!this.isValidCoord(x, y)) return;
        
        const layer = this.currentMap.layers[this.currentLayer];
        
        for (let dy = 0; dy < this.brushSize; dy++) {
            for (let dx = 0; dx < this.brushSize; dx++) {
                const px = x + dx;
                const py = y + dy;
                if (this.isValidCoord(px, py)) {
                    if (this.currentLayer === 'terrain') {
                        // El terreno siempre tiene algo, poner hierba
                        layer[py][px] = { tileId: 'grass' };
                    } else {
                        layer[py][px] = null;
                    }
                }
            }
        }
    }
    
    floodFill(startX, startY) {
        if (!this.selectedTile || !this.isValidCoord(startX, startY)) return;
        
        const layer = this.currentMap.layers[this.currentLayer];
        const targetTileId = layer[startY][startX]?.tileId;
        const replaceTileId = this.selectedTile.id;
        
        if (targetTileId === replaceTileId) return;
        
        const stack = [{ x: startX, y: startY }];
        const visited = new Set();
        
        while (stack.length > 0) {
            const { x, y } = stack.pop();
            const key = `${x},${y}`;
            
            if (visited.has(key) || !this.isValidCoord(x, y)) continue;
            if (layer[y][x]?.tileId !== targetTileId) continue;
            
            visited.add(key);
            layer[y][x] = { tileId: replaceTileId };
            
            stack.push({ x: x + 1, y });
            stack.push({ x: x - 1, y });
            stack.push({ x, y: y + 1 });
            stack.push({ x, y: y - 1 });
        }
    }
    
    pickTile(x, y) {
        if (!this.isValidCoord(x, y)) return;
        
        const layer = this.currentMap.layers[this.currentLayer];
        const cell = layer[y][x];
        
        if (cell?.tileId && this.tiles[cell.tileId]) {
            this.selectTile(cell.tileId);
        }
    }
    
    isValidCoord(x, y) {
        return x >= 0 && x < this.mapWidth && y >= 0 && y < this.mapHeight;
    }
    
    // === Renderizado ===
    
    render() {
        if (!this.ctx || !this.currentMap) {
            return;
        }
        
        // Limpiar canvas
        this.ctx.fillStyle = '#1a1a2e';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Renderizar capas en orden
        this.layers.forEach(layerName => {
            if (!this.layerVisibility[layerName]) return;
            this.renderLayer(layerName);
        });
        
        // Dibujar grid
        this.drawGrid();
    }
    
    renderLayer(layerName) {
        const layer = this.currentMap.layers[layerName];
        if (!layer) {
            console.log('Layer no existe:', layerName);
            return;
        }
        
        let tilesDrawn = 0;
        
        // Primer pase: tiles normales y partes de multi-tiles
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                const cell = layer[y][x];
                if (cell?.tileId) {
                    const tile = this.tiles[cell.tileId];
                    if (!tile && y === 0 && x === 0) {
                        console.log('❌ Tile no encontrado:', cell.tileId, 'Tiles disponibles:', Object.keys(this.tiles).slice(0, 5));
                    }
                    if (tile) {
                        // Si es parte de un multi-tile (no el centro), NO dibujar nada
                        // La imagen completa se dibujará desde el centro
                        if (cell.isMultiPart) {
                            // No dibujar nada - la imagen se dibuja completa desde el centro
                            continue;
                        } else if (cell.isMultiCenter) {
                            // Se dibuja en el segundo pase
                            continue;
                        } else {
                            // Tile normal de 1 hex
                            this.drawTile(x, y, tile, cell);
                        }
                    }
                }
            }
        }
        
        // Segundo pase: dibujar las imágenes multi-tile encima
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                const cell = layer[y][x];
                if (cell?.isMultiCenter && cell?.tileId) {
                    const tile = this.tiles[cell.tileId];
                    if (tile) {
                        this.drawMultiTile(x, y, tile, cell);
                    }
                }
            }
        }
    }
    
    drawTile(x, y, tile, cell = null) {
        if (this.gridType === 'hex') {
            this.drawHexTile(x, y, tile, cell);
        } else {
            this.drawSquareTile(x, y, tile);
        }
    }
    
    drawSquareTile(x, y, tile) {
        const px = x * this.tileSize;
        const py = y * this.tileSize;
        
        // Si hay imagen, usarla
        const img = this.tileImages[tile.id];
        if (img) {
            this.ctx.drawImage(img, px, py, this.tileSize, this.tileSize);
            return;
        }
        
        // Fallback a color sólido
        this.ctx.fillStyle = tile.color || '#333';
        this.ctx.fillRect(px, py, this.tileSize, this.tileSize);
        
        // Icono si hay espacio
        if (tile.icon && this.tileSize >= 24) {
            this.ctx.font = `${this.tileSize * 0.6}px Arial`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText(tile.icon, px + this.tileSize / 2, py + this.tileSize / 2);
        }
        
        // Indicadores especiales
        if (tile.blocksVision) {
            this.ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            this.ctx.lineWidth = 2;
            this.ctx.strokeRect(px + 1, py + 1, this.tileSize - 2, this.tileSize - 2);
        }
    }
    
    drawHexTile(x, y, tile, cell = null) {
        // Hexágonos flat-top (lado plano arriba) - igual que display/renderer.js
        const size = this.tileSize / 2; // Radio del hexágono
        
        // Dimensiones de un hexágono flat-top
        const hexWidth = size * 2;              // Ancho = 2 * radio
        const hexHeight = Math.sqrt(3) * size;  // Alto = sqrt(3) * radio
        
        // Espaciado entre centros
        const horizSpacing = hexWidth * 0.75;   // Horizontal: 3/4 de ancho
        const vertSpacing = hexHeight;          // Vertical: alto completo
        
        // Columnas impares se desplazan medio hexágono hacia abajo
        const offsetY = (x % 2 === 1) ? hexHeight / 2 : 0;
        
        const cx = x * horizSpacing + size;
        const cy = offsetY + y * vertSpacing + hexHeight / 2;
        const radius = size;
        
        // Obtener elevación del cell (si existe)
        const elevation = cell?.elevation || 0;
        
        // Si hay imagen, dibujarla dentro del hexágono (carga lazy)
        const img = this.getTileImage(tile.id);
        if (img) {
            this.ctx.save();
            
            // Clip hexagonal ligeramente más grande para overlap
            const clipRadius = radius * 1.03;
            this.ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i;
                const hx = cx + clipRadius * Math.cos(angle);
                const hy = cy + clipRadius * Math.sin(angle);
                if (i === 0) {
                    this.ctx.moveTo(hx, hy);
                } else {
                    this.ctx.lineTo(hx, hy);
                }
            }
            this.ctx.closePath();
            this.ctx.clip();
            
            // Dibujar imagen más grande para cubrir todo el hex
            const imgSize = radius * 2.2;
            this.ctx.drawImage(img, cx - imgSize/2, cy - imgSize/2, imgSize, imgSize);
            this.ctx.restore();
            
            // Borde del hexágono - solo si está activado
            if (this.showHexBorders) {
                this.ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI / 3) * i;
                    const hx = cx + radius * Math.cos(angle);
                    const hy = cy + radius * Math.sin(angle);
                    if (i === 0) {
                        this.ctx.moveTo(hx, hy);
                    } else {
                        this.ctx.lineTo(hx, hy);
                    }
                }
                this.ctx.closePath();
                this.ctx.strokeStyle = 'rgba(0,0,0,0.2)';
                this.ctx.lineWidth = 0.5;
                this.ctx.stroke();
            }
            
            // Mostrar elevación si es BattleTech y mayor a 0
            if (this.systemId === 'battletech' && elevation > 0) {
                this.drawElevationIndicator(cx, cy, radius, elevation);
            }
            return;
        }
        
        // Fallback: dibujar hexágono con color (flat-top)
        this.ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = (Math.PI / 3) * i; // 0° = lado derecho plano
            const hx = cx + radius * Math.cos(angle);
            const hy = cy + radius * Math.sin(angle);
            if (i === 0) {
                this.ctx.moveTo(hx, hy);
            } else {
                this.ctx.lineTo(hx, hy);
            }
        }
        this.ctx.closePath();
        
        // Color base o gradiente para más detalle
        const baseColor = tile.colors?.base || tile.color || '#333';
        if (tile.colors && this.tileSize >= 30) {
            // Crear gradiente para efecto de profundidad
            const gradient = this.ctx.createRadialGradient(
                cx - radius * 0.3, cy - radius * 0.3, 0,
                cx, cy, radius
            );
            gradient.addColorStop(0, tile.colors.variation1 || this.lightenColor(baseColor, 15));
            gradient.addColorStop(0.7, baseColor);
            gradient.addColorStop(1, tile.colors.variation2 || this.darkenColor(baseColor, 15));
            this.ctx.fillStyle = gradient;
        } else {
            this.ctx.fillStyle = baseColor;
        }
        this.ctx.fill();
        
        // Añadir textura/patrón según tipo de tile
        if (this.tileSize >= 30 && tile.pattern) {
            this.drawTilePattern(cx, cy, radius, tile);
        }
        
        // Indicador de elevación
        if (tile.elevation && tile.elevation > 0) {
            this.drawElevationIndicator(cx, cy, radius, tile.elevation);
        }
        
        // Indicador de bloqueo de visión
        if (tile.blocksVision || tile.blocksLOS) {
            this.ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
        }
        
        // Indicador de cobertura
        if (tile.providesCover && tile.providesCover !== false) {
            this.drawCoverIndicator(cx, cy, radius, tile.providesCover);
        }
        
        // Icono para tiles pequeños o sin patrón
        if (tile.icon && (this.tileSize < 30 || !tile.pattern)) {
            this.ctx.font = `${this.tileSize * 0.35}px Arial`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillStyle = '#fff';
            this.ctx.shadowColor = 'rgba(0,0,0,0.5)';
            this.ctx.shadowBlur = 2;
            this.ctx.fillText(tile.icon, cx, cy);
            this.ctx.shadowBlur = 0;
        }
    }
    
    /**
     * Dibuja un multi-tile (imagen que cubre múltiples hexágonos)
     */
    drawMultiTile(x, y, tile, cell) {
        const size = this.tileSize / 2;
        const hexWidth = size * 2;
        const hexHeight = Math.sqrt(3) * size;
        const horizSpacing = hexWidth * 0.75;
        const vertSpacing = hexHeight;
        
        const img = this.tileImages[tile.id];
        if (!img) {
            this.drawHexTile(x, y, tile, cell);
            return;
        }
        
        // Obtener todas las celdas que ocupa este multi-tile
        const cells = this.getMultiTileCells(tile, x, y);
        
        // Calcular centros de cada celda y el bounding box exacto
        const cellCenters = [];
        let minPx = Infinity, maxPx = -Infinity;
        let minPy = Infinity, maxPy = -Infinity;
        
        cells.forEach(cell => {
            const cellOffsetY = (cell.x % 2 === 1) ? hexHeight / 2 : 0;
            const cellCx = cell.x * horizSpacing + size;
            const cellCy = cellOffsetY + cell.y * vertSpacing + hexHeight / 2;
            
            cellCenters.push({ cx: cellCx, cy: cellCy });
            
            // Para flat-top, los extremos del hexágono son:
            // - Horizontal: cx ± size (radio)
            // - Vertical: cy ± hexHeight/2
            minPx = Math.min(minPx, cellCx - size);
            maxPx = Math.max(maxPx, cellCx + size);
            minPy = Math.min(minPy, cellCy - hexHeight / 2);
            maxPy = Math.max(maxPy, cellCy + hexHeight / 2);
        });
        
        this.ctx.save();
        
        // Crear path de clip con todos los hexágonos (flat-top)
        this.ctx.beginPath();
        cellCenters.forEach(center => {
            this.ctx.moveTo(center.cx + size, center.cy);
            for (let i = 1; i <= 6; i++) {
                const angle = (Math.PI / 3) * i;
                this.ctx.lineTo(
                    center.cx + size * Math.cos(angle), 
                    center.cy + size * Math.sin(angle)
                );
            }
        });
        this.ctx.clip();
        
        // Dimensiones del área combinada
        const areaWidth = maxPx - minPx;
        const areaHeight = maxPy - minPy;
        const areaCx = (minPx + maxPx) / 2;
        const areaCy = (minPy + maxPy) / 2;
        
        // Escalar imagen para cubrir toda el área (cover, no contain)
        const imgAspect = img.width / img.height;
        const areaAspect = areaWidth / areaHeight;
        
        let drawWidth, drawHeight;
        
        // Usar "cover" - la imagen cubre todo el área, puede recortarse
        if (imgAspect > areaAspect) {
            // Imagen más ancha que el área - ajustar por altura
            drawHeight = areaHeight;
            drawWidth = drawHeight * imgAspect;
        } else {
            // Imagen más alta que el área - ajustar por ancho
            drawWidth = areaWidth;
            drawHeight = drawWidth / imgAspect;
        }
        
        // Dibujar imagen centrada
        this.ctx.drawImage(
            img, 
            areaCx - drawWidth / 2, 
            areaCy - drawHeight / 2, 
            drawWidth, 
            drawHeight
        );
        
        this.ctx.restore();
        
        // Bordes sutiles
        this.ctx.strokeStyle = 'rgba(0,0,0,0.15)';
        this.ctx.lineWidth = 0.5;
        cellCenters.forEach(center => {
            this.ctx.beginPath();
            this.ctx.moveTo(center.cx + size, center.cy);
            for (let i = 1; i <= 6; i++) {
                const angle = (Math.PI / 3) * i;
                this.ctx.lineTo(
                    center.cx + size * Math.cos(angle), 
                    center.cy + size * Math.sin(angle)
                );
            }
            this.ctx.stroke();
        });
    }
    
    drawTilePattern(cx, cy, radius, tile) {
        this.ctx.save();
        
        // Clipear al hexágono (flat-top)
        this.ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const angle = (Math.PI / 3) * i; // 0° = lado derecho plano
            const hx = cx + radius * Math.cos(angle);
            const hy = cy + radius * Math.sin(angle);
            if (i === 0) this.ctx.moveTo(hx, hy);
            else this.ctx.lineTo(hx, hy);
        }
        this.ctx.closePath();
        this.ctx.clip();
        
        switch (tile.pattern) {
            case 'scattered_trees':
            case 'dense_trees':
                this.drawTreePattern(cx, cy, radius, tile);
                break;
            case 'building_top':
            case 'bunker_top':
                this.drawBuildingPattern(cx, cy, radius, tile);
                break;
            case 'water':
            case 'deep_water':
                this.drawWaterPattern(cx, cy, radius, tile);
                break;
            case 'rubble':
                this.drawRubblePattern(cx, cy, radius, tile);
                break;
            case 'contour':
                this.drawContourPattern(cx, cy, radius, tile);
                break;
            case 'factory_top':
                this.drawFactoryPattern(cx, cy, radius, tile);
                break;
            case 'cylinder_top':
                this.drawCylinderPattern(cx, cy, radius, tile);
                break;
        }
        
        this.ctx.restore();
    }
    
    drawTreePattern(cx, cy, radius, tile) {
        const isDense = tile.pattern === 'dense_trees';
        const numTrees = isDense ? 5 : 3;
        const treeColor = tile.colors?.trees || '#2e7d32';
        const shadowColor = tile.colors?.shadows || '#1b5e20';
        
        for (let i = 0; i < numTrees; i++) {
            const angle = (Math.PI * 2 / numTrees) * i + (i % 2) * 0.3;
            const dist = radius * (isDense ? 0.4 : 0.5);
            const tx = cx + Math.cos(angle) * dist * (0.5 + Math.random() * 0.5);
            const ty = cy + Math.sin(angle) * dist * (0.5 + Math.random() * 0.5);
            const treeRadius = radius * (isDense ? 0.25 : 0.3);
            
            // Sombra del árbol
            this.ctx.fillStyle = shadowColor;
            this.ctx.beginPath();
            this.ctx.arc(tx + 2, ty + 2, treeRadius, 0, Math.PI * 2);
            this.ctx.fill();
            
            // Copa del árbol (vista cenital)
            const treeGradient = this.ctx.createRadialGradient(tx - 2, ty - 2, 0, tx, ty, treeRadius);
            treeGradient.addColorStop(0, this.lightenColor(treeColor, 20));
            treeGradient.addColorStop(0.5, treeColor);
            treeGradient.addColorStop(1, shadowColor);
            this.ctx.fillStyle = treeGradient;
            this.ctx.beginPath();
            this.ctx.arc(tx, ty, treeRadius, 0, Math.PI * 2);
            this.ctx.fill();
        }
        
        // Árbol central para bosque denso
        if (isDense) {
            const centerGradient = this.ctx.createRadialGradient(cx - 2, cy - 2, 0, cx, cy, radius * 0.35);
            centerGradient.addColorStop(0, this.lightenColor(treeColor, 15));
            centerGradient.addColorStop(1, shadowColor);
            this.ctx.fillStyle = centerGradient;
            this.ctx.beginPath();
            this.ctx.arc(cx, cy, radius * 0.35, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }
    
    drawBuildingPattern(cx, cy, radius, tile) {
        const wallColor = tile.colors?.walls || '#78909c';
        const roofColor = tile.colors?.roof || '#546e7a';
        const shadowColor = tile.colors?.shadow || '#455a64';
        
        // Techo del edificio (vista cenital)
        const roofSize = radius * 0.75;
        this.ctx.fillStyle = roofColor;
        this.ctx.fillRect(cx - roofSize, cy - roofSize, roofSize * 2, roofSize * 2);
        
        // Borde/pared visible
        this.ctx.strokeStyle = wallColor;
        this.ctx.lineWidth = 3;
        this.ctx.strokeRect(cx - roofSize, cy - roofSize, roofSize * 2, roofSize * 2);
        
        // Sombra del edificio
        this.ctx.fillStyle = shadowColor;
        this.ctx.fillRect(cx + roofSize * 0.8, cy - roofSize, roofSize * 0.3, roofSize * 2.3);
        this.ctx.fillRect(cx - roofSize, cy + roofSize * 0.8, roofSize * 2.1, roofSize * 0.3);
        
        // Detalles del techo: unidades de AC, ventilación
        if (tile.pattern !== 'bunker_top') {
            // Unidad de aire
            this.ctx.fillStyle = '#90a4ae';
            this.ctx.fillRect(cx - radius * 0.2, cy - radius * 0.2, radius * 0.25, radius * 0.25);
            
            // Ventilación
            this.ctx.fillStyle = '#37474f';
            this.ctx.beginPath();
            this.ctx.arc(cx + radius * 0.3, cy + radius * 0.3, radius * 0.1, 0, Math.PI * 2);
            this.ctx.fill();
        } else {
            // Bunker: escotilla
            this.ctx.fillStyle = '#263238';
            this.ctx.beginPath();
            this.ctx.arc(cx, cy, radius * 0.2, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.strokeStyle = '#455a64';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
        }
    }
    
    drawWaterPattern(cx, cy, radius, tile) {
        const baseColor = tile.colors?.base || '#4fc3f7';
        const rippleColor = tile.colors?.ripples || '#81d4fa';
        
        // Ondas concéntricas
        for (let i = 3; i >= 0; i--) {
            const waveRadius = radius * (0.3 + i * 0.2);
            this.ctx.strokeStyle = i % 2 === 0 ? rippleColor : baseColor;
            this.ctx.lineWidth = 2;
            this.ctx.beginPath();
            this.ctx.arc(cx, cy, waveRadius, 0, Math.PI * 2);
            this.ctx.stroke();
        }
        
        // Reflejos de luz
        this.ctx.fillStyle = 'rgba(255,255,255,0.3)';
        this.ctx.beginPath();
        this.ctx.ellipse(cx - radius * 0.3, cy - radius * 0.3, radius * 0.15, radius * 0.08, -Math.PI / 4, 0, Math.PI * 2);
        this.ctx.fill();
    }
    
    drawRubblePattern(cx, cy, radius, tile) {
        const debrisColor = tile.colors?.debris || '#9e9e9e';
        const concreteColor = tile.colors?.concrete || '#757575';
        
        // Piezas de escombros aleatorias
        const pieces = 6;
        for (let i = 0; i < pieces; i++) {
            const angle = (Math.PI * 2 / pieces) * i + Math.random() * 0.5;
            const dist = radius * (0.2 + Math.random() * 0.5);
            const px = cx + Math.cos(angle) * dist;
            const py = cy + Math.sin(angle) * dist;
            const size = radius * (0.1 + Math.random() * 0.15);
            
            this.ctx.fillStyle = i % 2 === 0 ? debrisColor : concreteColor;
            this.ctx.beginPath();
            // Forma irregular
            this.ctx.moveTo(px, py - size);
            this.ctx.lineTo(px + size * 0.8, py - size * 0.3);
            this.ctx.lineTo(px + size * 0.5, py + size * 0.7);
            this.ctx.lineTo(px - size * 0.6, py + size * 0.4);
            this.ctx.lineTo(px - size * 0.8, py - size * 0.5);
            this.ctx.closePath();
            this.ctx.fill();
        }
    }
    
    drawContourPattern(cx, cy, radius, tile) {
        // Líneas de contorno para elevación
        const contourColor = tile.colors?.contour || '#81c784';
        this.ctx.strokeStyle = contourColor;
        this.ctx.lineWidth = 1;
        
        for (let i = 1; i <= 3; i++) {
            const r = radius * (0.3 + i * 0.2);
            this.ctx.beginPath();
            this.ctx.arc(cx, cy, r, 0, Math.PI * 2);
            this.ctx.stroke();
        }
    }
    
    drawFactoryPattern(cx, cy, radius, tile) {
        const structureColor = tile.colors?.structure || '#607d8b';
        const smokestackColor = tile.colors?.smokestacks || '#37474f';
        
        // Estructura principal
        this.ctx.fillStyle = structureColor;
        this.ctx.fillRect(cx - radius * 0.6, cy - radius * 0.4, radius * 1.2, radius * 0.8);
        
        // Chimeneas
        this.ctx.fillStyle = smokestackColor;
        this.ctx.beginPath();
        this.ctx.arc(cx - radius * 0.3, cy - radius * 0.5, radius * 0.12, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.beginPath();
        this.ctx.arc(cx + radius * 0.3, cy - radius * 0.5, radius * 0.12, 0, Math.PI * 2);
        this.ctx.fill();
        
        // Humo (círculos claros)
        this.ctx.fillStyle = 'rgba(150,150,150,0.4)';
        this.ctx.beginPath();
        this.ctx.arc(cx - radius * 0.25, cy - radius * 0.7, radius * 0.15, 0, Math.PI * 2);
        this.ctx.fill();
    }
    
    drawCylinderPattern(cx, cy, radius, tile) {
        // Tanque cilíndrico (vista cenital)
        const tankColor = tile.colors?.tank || '#eceff1';
        const topColor = tile.colors?.top || '#cfd8dc';
        
        // Círculo principal
        const tankGradient = this.ctx.createRadialGradient(cx - radius * 0.2, cy - radius * 0.2, 0, cx, cy, radius * 0.7);
        tankGradient.addColorStop(0, '#ffffff');
        tankGradient.addColorStop(0.3, tankColor);
        tankGradient.addColorStop(1, topColor);
        this.ctx.fillStyle = tankGradient;
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, radius * 0.65, 0, Math.PI * 2);
        this.ctx.fill();
        
        // Borde
        this.ctx.strokeStyle = '#90a4ae';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
        
        // Detalle central
        this.ctx.fillStyle = '#607d8b';
        this.ctx.beginPath();
        this.ctx.arc(cx, cy, radius * 0.1, 0, Math.PI * 2);
        this.ctx.fill();
    }
    
    drawElevationIndicator(cx, cy, radius, elevation) {
        // Número de elevación pequeño en esquina superior derecha
        const fontSize = Math.max(8, this.tileSize * 0.18);
        
        // Posición en esquina superior derecha del hex
        const textX = cx + radius * 0.4;
        const textY = cy - radius * 0.4;
        
        // Fondo circular pequeño
        this.ctx.fillStyle = 'rgba(0,0,0,0.6)';
        this.ctx.beginPath();
        this.ctx.arc(textX, textY, fontSize * 0.6, 0, Math.PI * 2);
        this.ctx.fill();
        
        // Texto de elevación
        this.ctx.font = `bold ${fontSize}px Arial`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = '#fff';
        this.ctx.fillText(elevation.toString(), textX, textY);
    }
    
    drawCoverIndicator(cx, cy, radius, coverType) {
        // Pequeño escudo de cobertura
        const colors = {
            'light': '#4caf50',
            'partial': '#ff9800',
            'heavy': '#f44336',
            'hardened': '#9c27b0'
        };
        const color = colors[coverType] || colors['light'];
        
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.arc(cx - radius * 0.5, cy + radius * 0.5, radius * 0.12, 0, Math.PI * 2);
        this.ctx.fill();
    }
    
    lightenColor(color, percent) {
        const num = parseInt(color.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.min(255, (num >> 16) + amt);
        const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
        const B = Math.min(255, (num & 0x0000FF) + amt);
        return `#${(1 << 24 | R << 16 | G << 8 | B).toString(16).slice(1)}`;
    }
    
    darkenColor(color, percent) {
        const num = parseInt(color.replace('#', ''), 16);
        const amt = Math.round(2.55 * percent);
        const R = Math.max(0, (num >> 16) - amt);
        const G = Math.max(0, ((num >> 8) & 0x00FF) - amt);
        const B = Math.max(0, (num & 0x0000FF) - amt);
        return `#${(1 << 24 | R << 16 | G << 8 | B).toString(16).slice(1)}`;
    }
    
    drawGrid() {
        if (this.gridType === 'hex') {
            this.drawHexGrid();
        } else {
            this.drawSquareGrid();
        }
    }
    
    drawSquareGrid() {
        this.ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        this.ctx.lineWidth = 1;
        
        // Líneas verticales
        for (let x = 0; x <= this.mapWidth; x++) {
            this.ctx.beginPath();
            this.ctx.moveTo(x * this.tileSize, 0);
            this.ctx.lineTo(x * this.tileSize, this.canvas.height);
            this.ctx.stroke();
        }
        
        // Líneas horizontales
        for (let y = 0; y <= this.mapHeight; y++) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y * this.tileSize);
            this.ctx.lineTo(this.canvas.width, y * this.tileSize);
            this.ctx.stroke();
        }
    }
    
    drawHexGrid() {
        // Hexágonos flat-top (lado plano arriba)
        const size = this.tileSize / 2; // Radio del hexágono
        
        // Dimensiones de un hexágono flat-top
        const hexWidth = size * 2;
        const hexHeight = Math.sqrt(3) * size;
        
        // Espaciado entre centros
        const horizSpacing = hexWidth * 0.75;
        const vertSpacing = hexHeight;
        
        this.ctx.strokeStyle = 'rgba(255, 215, 0, 0.25)';
        this.ctx.lineWidth = 1;
        
        for (let x = 0; x < this.mapWidth; x++) {
            // Columnas impares se desplazan medio hexágono hacia abajo
            const offsetY = (x % 2 === 1) ? hexHeight / 2 : 0;
            
            for (let y = 0; y < this.mapHeight; y++) {
                const cx = x * horizSpacing + size;
                const cy = offsetY + y * vertSpacing + hexHeight / 2;
                
                this.ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    // Flat-top: empieza desde derecha (ángulo 0°)
                    const angle = (Math.PI / 3) * i;
                    const hx = cx + size * Math.cos(angle);
                    const hy = cy + size * Math.sin(angle);
                    if (i === 0) {
                        this.ctx.moveTo(hx, hy);
                    } else {
                        this.ctx.lineTo(hx, hy);
                    }
                }
                this.ctx.closePath();
                this.ctx.stroke();
            }
        }
    }
    
    // === Herramientas ===
    
    setTool(tool) {
        this.currentTool = tool;
        
        // Actualizar UI
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tool === tool);
        });
    }
    
    setBrushSize(size) {
        this.brushSize = Math.max(1, Math.min(5, size));
        const el = document.getElementById('brush-size-value');
        if (el) el.textContent = this.brushSize;
    }
    
    setShowHexBorders(show) {
        this.showHexBorders = show;
        this.render();
    }
    
    setLayer(layer) {
        this.currentLayer = layer;
        
        document.querySelectorAll('.layer-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.layer === layer);
        });
    }
    
    toggleLayerVisibility(layer) {
        this.layerVisibility[layer] = !this.layerVisibility[layer];
        this.render();
    }
    
    // === Undo/Redo ===
    
    saveUndoState() {
        const state = JSON.stringify(this.currentMap.layers);
        this.undoStack.push(state);
        
        if (this.undoStack.length > this.maxUndoSteps) {
            this.undoStack.shift();
        }
        
        this.redoStack = [];
    }
    
    undo() {
        if (this.undoStack.length === 0) return;
        
        const currentState = JSON.stringify(this.currentMap.layers);
        this.redoStack.push(currentState);
        
        const previousState = this.undoStack.pop();
        this.currentMap.layers = JSON.parse(previousState);
        
        this.render();
    }
    
    redo() {
        if (this.redoStack.length === 0) return;
        
        const currentState = JSON.stringify(this.currentMap.layers);
        this.undoStack.push(currentState);
        
        const nextState = this.redoStack.pop();
        this.currentMap.layers = JSON.parse(nextState);
        
        this.render();
    }
    
    // === Guardar/Cargar ===
    
    async saveMap() {
        if (!this.currentMap) return;
        
        const name = prompt('Nombre del mapa:', this.currentMap.name);
        if (!name) return;
        
        this.currentMap.name = name;
        this.currentMap.modified = new Date().toISOString();
        
        try {
            const response = await fetch('/api/maps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.currentMap)
            });
            
            if (response.ok) {
                const result = await response.json();
                this.currentMap.id = result.id;
                showToast('✓ Mapa guardado', 'success');
            } else {
                throw new Error('Error guardando');
            }
        } catch (error) {
            console.error('Error guardando mapa:', error);
            showToast('Error al guardar el mapa', 'error');
        }
    }
    
    async loadMap(mapId) {
        try {
            const response = await fetch(`/api/maps/${mapId}`);
            if (response.ok) {
                const mapData = await response.json();
                this.currentMap = mapData;
                this.mapWidth = mapData.width;
                this.mapHeight = mapData.height;
                this.resizeCanvas();
                this.render();
                showToast(`✓ Mapa "${mapData.name}" cargado`);
            }
        } catch (error) {
            console.error('Error cargando mapa:', error);
            showToast('Error al cargar el mapa', 'error');
        }
    }
    
    async loadMapList() {
        try {
            const response = await fetch('/api/maps');
            if (response.ok) {
                return await response.json();
            }
        } catch (error) {
            console.error('Error cargando lista de mapas:', error);
        }
        return [];
    }
    
    // === Generación Procedural ===
    
    async generateProceduralMap(options = {}) {
        const width = options.width || this.mapWidth;
        const height = options.height || this.mapHeight;
        const type = options.type || 'dungeon'; // 'dungeon', 'forest', 'cave', 'town'
        
        showToast('🎲 Generando mapa...', 'info');
        
        try {
            const response = await fetch('/api/maps/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ width, height, type })
            });
            
            if (response.ok) {
                const mapData = await response.json();
                this.currentMap = mapData;
                this.mapWidth = mapData.width;
                this.mapHeight = mapData.height;
                this.resizeCanvas();
                this.render();
                showToast(`✓ Mapa "${type}" generado`, 'success');
            } else {
                throw new Error('Error generando');
            }
        } catch (error) {
            console.error('Error generando mapa:', error);
            // Fallback: generar localmente
            this.generateLocalMap(width, height, type);
        }
    }
    
    generateLocalMap(width, height, type) {
        // Si es BattleTech, usar el generador especializado
        if (this.systemId === 'battletech' && type.startsWith('bt_')) {
            this.generateBattleTechMap(width, height, type);
            return;
        }
        
        // Determinar tile base según sistema
        const baseTile = this.systemId === 'battletech' ? 'bt_11' : 'grass';
        this.createNewMap(width, height, baseTile);
        
        switch (type) {
            case 'dungeon':
                this.generateDungeon();
                break;
            case 'forest':
                this.generateForest();
                break;
            case 'cave':
                this.generateCave();
                break;
            case 'town':
                this.generateTown();
                break;
        }
        
        this.render();
    }
    
    /**
     * Genera un mapa de BattleTech usando el generador especializado
     */
    generateBattleTechMap(width, height, type) {
        console.log(`🎮 Generando mapa BattleTech: ${width}x${height} tipo: ${type}`);
        
        // Crear o reusar el generador
        if (!this.btGenerator) {
            this.btGenerator = new BattleTechMapGenerator(this);
        }
        
        // Generar el mapa
        const mapData = this.btGenerator.generate(width, height, type);
        
        // Aplicar al editor
        this.mapWidth = mapData.width;
        this.mapHeight = mapData.height;
        this.gridType = mapData.gridType || 'hex';
        this.currentMap = mapData;
        
        // Asegurar que el mapa tenga gridType
        this.currentMap.gridType = this.gridType;
        
        console.log('📊 Mapa generado:', mapData);
        
        this.render();
    }
    
    generateDungeon() {
        const layer = this.currentMap.layers.terrain;
        
        // Rellenar todo con muros
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                layer[y][x] = { tileId: 'wall_stone' };
            }
        }
        
        // Crear habitaciones
        const rooms = [];
        const numRooms = Math.floor((this.mapWidth * this.mapHeight) / 50);
        
        for (let i = 0; i < numRooms; i++) {
            const roomW = 3 + Math.floor(Math.random() * 5);
            const roomH = 3 + Math.floor(Math.random() * 5);
            const roomX = 1 + Math.floor(Math.random() * (this.mapWidth - roomW - 2));
            const roomY = 1 + Math.floor(Math.random() * (this.mapHeight - roomH - 2));
            
            // Verificar que no se solape con otras habitaciones
            let overlaps = false;
            for (const room of rooms) {
                if (roomX < room.x + room.w + 1 && roomX + roomW + 1 > room.x &&
                    roomY < room.y + room.h + 1 && roomY + roomH + 1 > room.y) {
                    overlaps = true;
                    break;
                }
            }
            
            if (!overlaps) {
                rooms.push({ x: roomX, y: roomY, w: roomW, h: roomH });
                
                // Crear la habitación
                for (let dy = 0; dy < roomH; dy++) {
                    for (let dx = 0; dx < roomW; dx++) {
                        layer[roomY + dy][roomX + dx] = { tileId: 'stone_floor' };
                    }
                }
            }
        }
        
        // Conectar habitaciones con pasillos
        for (let i = 1; i < rooms.length; i++) {
            const roomA = rooms[i - 1];
            const roomB = rooms[i];
            
            const ax = Math.floor(roomA.x + roomA.w / 2);
            const ay = Math.floor(roomA.y + roomA.h / 2);
            const bx = Math.floor(roomB.x + roomB.w / 2);
            const by = Math.floor(roomB.y + roomB.h / 2);
            
            // Pasillo horizontal luego vertical
            if (Math.random() > 0.5) {
                this.carveHorizontalCorridor(layer, ax, bx, ay);
                this.carveVerticalCorridor(layer, ay, by, bx);
            } else {
                this.carveVerticalCorridor(layer, ay, by, ax);
                this.carveHorizontalCorridor(layer, ax, bx, by);
            }
        }
        
        // Añadir puertas en algunos puntos
        this.addDoors(layer, rooms);
    }
    
    carveHorizontalCorridor(layer, x1, x2, y) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        for (let x = minX; x <= maxX; x++) {
            if (this.isValidCoord(x, y)) {
                layer[y][x] = { tileId: 'stone_floor' };
            }
        }
    }
    
    carveVerticalCorridor(layer, y1, y2, x) {
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        for (let y = minY; y <= maxY; y++) {
            if (this.isValidCoord(x, y)) {
                layer[y][x] = { tileId: 'stone_floor' };
            }
        }
    }
    
    addDoors(layer, rooms) {
        // Añadir algunas puertas en las entradas de las habitaciones
        rooms.forEach(room => {
            // Buscar posiciones de puerta (donde hay muro adyacente a suelo)
            const doorPositions = [];
            
            // Lado superior
            for (let x = room.x; x < room.x + room.w; x++) {
                if (room.y > 0 && layer[room.y - 1][x]?.tileId === 'stone_floor') {
                    doorPositions.push({ x, y: room.y - 1 });
                }
            }
            
            // Elegir una puerta aleatoria
            if (doorPositions.length > 0 && Math.random() > 0.5) {
                const pos = doorPositions[Math.floor(Math.random() * doorPositions.length)];
                layer[pos.y][pos.x] = { tileId: 'door_wood' };
            }
        });
    }
    
    generateForest() {
        const layer = this.currentMap.layers.terrain;
        const objLayer = this.currentMap.layers.objects;
        
        // Base de hierba
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                layer[y][x] = { tileId: 'grass' };
                
                // Añadir árboles aleatorios
                if (Math.random() < 0.2) {
                    objLayer[y][x] = { tileId: 'tree' };
                } else if (Math.random() < 0.1) {
                    objLayer[y][x] = { tileId: 'bush' };
                } else if (Math.random() < 0.05) {
                    objLayer[y][x] = { tileId: 'rock' };
                }
            }
        }
        
        // Crear un camino
        const pathY = Math.floor(this.mapHeight / 2);
        for (let x = 0; x < this.mapWidth; x++) {
            const y = pathY + Math.floor(Math.sin(x * 0.3) * 2);
            if (this.isValidCoord(x, y)) {
                layer[y][x] = { tileId: 'dirt' };
                objLayer[y][x] = null;
                // Limpiar alrededor del camino
                if (this.isValidCoord(x, y - 1)) objLayer[y - 1][x] = null;
                if (this.isValidCoord(x, y + 1)) objLayer[y + 1][x] = null;
            }
        }
    }
    
    generateCave() {
        const layer = this.currentMap.layers.terrain;
        
        // Usar autómata celular para generar cueva
        // Paso 1: Ruido inicial
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                // Bordes siempre son muro
                if (x === 0 || x === this.mapWidth - 1 || y === 0 || y === this.mapHeight - 1) {
                    layer[y][x] = { tileId: 'wall_stone' };
                } else {
                    layer[y][x] = { tileId: Math.random() < 0.45 ? 'wall_stone' : 'stone_floor' };
                }
            }
        }
        
        // Paso 2: Suavizar con autómata celular
        for (let iteration = 0; iteration < 5; iteration++) {
            const newLayer = JSON.parse(JSON.stringify(layer));
            
            for (let y = 1; y < this.mapHeight - 1; y++) {
                for (let x = 1; x < this.mapWidth - 1; x++) {
                    let walls = 0;
                    
                    // Contar muros adyacentes
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            if (layer[y + dy][x + dx]?.tileId === 'wall_stone') {
                                walls++;
                            }
                        }
                    }
                    
                    // Regla del autómata
                    if (walls >= 5) {
                        newLayer[y][x] = { tileId: 'wall_stone' };
                    } else {
                        newLayer[y][x] = { tileId: 'stone_floor' };
                    }
                }
            }
            
            // Copiar resultado
            for (let y = 0; y < this.mapHeight; y++) {
                for (let x = 0; x < this.mapWidth; x++) {
                    layer[y][x] = newLayer[y][x];
                }
            }
        }
        
        // Añadir agua en algunas zonas bajas
        for (let y = 1; y < this.mapHeight - 1; y++) {
            for (let x = 1; x < this.mapWidth - 1; x++) {
                if (layer[y][x]?.tileId === 'stone_floor' && Math.random() < 0.05) {
                    layer[y][x] = { tileId: 'water_shallow' };
                }
            }
        }
    }
    
    generateTown() {
        const layer = this.currentMap.layers.terrain;
        const objLayer = this.currentMap.layers.objects;
        
        // Base de hierba
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                layer[y][x] = { tileId: 'grass' };
            }
        }
        
        // Calles principales
        const mainStreetY = Math.floor(this.mapHeight / 2);
        const mainStreetX = Math.floor(this.mapWidth / 2);
        
        for (let x = 0; x < this.mapWidth; x++) {
            layer[mainStreetY][x] = { tileId: 'dirt' };
            if (mainStreetY + 1 < this.mapHeight) layer[mainStreetY + 1][x] = { tileId: 'dirt' };
        }
        
        for (let y = 0; y < this.mapHeight; y++) {
            layer[y][mainStreetX] = { tileId: 'dirt' };
            if (mainStreetX + 1 < this.mapWidth) layer[y][mainStreetX + 1] = { tileId: 'dirt' };
        }
        
        // Crear edificios
        const buildings = [
            { x: 2, y: 2, w: 5, h: 4 },
            { x: this.mapWidth - 7, y: 2, w: 5, h: 4 },
            { x: 2, y: this.mapHeight - 6, w: 5, h: 4 },
            { x: this.mapWidth - 7, y: this.mapHeight - 6, w: 5, h: 4 }
        ];
        
        buildings.forEach(building => {
            // Suelo del edificio
            for (let dy = 0; dy < building.h; dy++) {
                for (let dx = 0; dx < building.w; dx++) {
                    const x = building.x + dx;
                    const y = building.y + dy;
                    if (this.isValidCoord(x, y)) {
                        layer[y][x] = { tileId: 'wood_floor' };
                    }
                }
            }
            
            // Paredes
            for (let dx = 0; dx < building.w; dx++) {
                if (this.isValidCoord(building.x + dx, building.y)) {
                    objLayer[building.y][building.x + dx] = { tileId: 'wall_wood' };
                }
                if (this.isValidCoord(building.x + dx, building.y + building.h - 1)) {
                    objLayer[building.y + building.h - 1][building.x + dx] = { tileId: 'wall_wood' };
                }
            }
            for (let dy = 0; dy < building.h; dy++) {
                if (this.isValidCoord(building.x, building.y + dy)) {
                    objLayer[building.y + dy][building.x] = { tileId: 'wall_wood' };
                }
                if (this.isValidCoord(building.x + building.w - 1, building.y + dy)) {
                    objLayer[building.y + dy][building.x + building.w - 1] = { tileId: 'wall_wood' };
                }
            }
            
            // Puerta
            const doorX = building.x + Math.floor(building.w / 2);
            const doorY = building.y + building.h - 1;
            if (this.isValidCoord(doorX, doorY)) {
                objLayer[doorY][doorX] = { tileId: 'door_wood' };
            }
        });
    }
    
    // === BattleTech Map Generators ===
    
    /**
     * Helper: obtiene un tile aleatorio de un grupo
     */
    getRandomBTTile(group) {
        const tiles = Object.keys(this.tiles).filter(id => {
            const tile = this.tiles[id];
            return tile.group === group || id.startsWith(`bt_${group}`);
        });
        if (tiles.length === 0) return `bt_${group}`;
        return tiles[Math.floor(Math.random() * tiles.length)];
    }
    
    /**
     * Grasslands - Llanuras con bosques dispersos
     */
    generateBTGrasslands() {
        const layer = this.currentMap.layers.terrain;
        
        // Base de llanura
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                layer[y][x] = { tileId: 'bt_11' }; // Llanura
            }
        }
        
        // Clusters de bosques (15% del mapa)
        const numClusters = Math.floor((this.mapWidth * this.mapHeight) * 0.03);
        for (let i = 0; i < numClusters; i++) {
            const cx = Math.floor(Math.random() * this.mapWidth);
            const cy = Math.floor(Math.random() * this.mapHeight);
            const size = 2 + Math.floor(Math.random() * 3);
            
            this.placeBTCluster(layer, cx, cy, size, ['13', '14', '16', '19', '20']);
        }
        
        // Algunos bosques densos (5%)
        const numDense = Math.floor((this.mapWidth * this.mapHeight) * 0.01);
        for (let i = 0; i < numDense; i++) {
            const x = Math.floor(Math.random() * this.mapWidth);
            const y = Math.floor(Math.random() * this.mapHeight);
            if (this.isValidCoord(x, y)) {
                layer[y][x] = { tileId: this.getRandomBTTile('15') };
            }
        }
        
        // Terreno rocoso disperso
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                if (layer[y][x].tileId === 'bt_11' && Math.random() < 0.03) {
                    layer[y][x] = { tileId: this.getRandomBTTile('59') };
                }
            }
        }
    }
    
    /**
     * Forest - Bosque denso con claros
     */
    generateBTForest() {
        const layer = this.currentMap.layers.terrain;
        
        // Todo bosque denso primero
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                const r = Math.random();
                if (r < 0.4) {
                    layer[y][x] = { tileId: this.getRandomBTTile('15') }; // Denso
                } else if (r < 0.8) {
                    layer[y][x] = { tileId: this.getRandomBTTile('13') }; // Normal
                } else {
                    layer[y][x] = { tileId: 'bt_11' }; // Claro
                }
            }
        }
        
        // Crear algunos claros grandes
        const numClearings = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < numClearings; i++) {
            const cx = Math.floor(Math.random() * this.mapWidth);
            const cy = Math.floor(Math.random() * this.mapHeight);
            const size = 2 + Math.floor(Math.random() * 2);
            
            this.placeBTCluster(layer, cx, cy, size, ['11']);
        }
        
        // Un pequeño lago o arroyo
        if (Math.random() < 0.5) {
            const lx = Math.floor(Math.random() * (this.mapWidth - 4)) + 2;
            const ly = Math.floor(Math.random() * (this.mapHeight - 4)) + 2;
            this.placeBTCluster(layer, lx, ly, 2, ['27', '28', '29', '30']);
        }
    }
    
    /**
     * City - Ciudad con edificios y calles
     */
    generateBTCity() {
        const layer = this.currentMap.layers.terrain;
        
        // Base de llanura (calles)
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                layer[y][x] = { tileId: 'bt_11' };
            }
        }
        
        // Crear grid de edificios
        const blockSize = 4;
        const streetWidth = 1;
        
        for (let by = 0; by < Math.floor(this.mapHeight / (blockSize + streetWidth)); by++) {
            for (let bx = 0; bx < Math.floor(this.mapWidth / (blockSize + streetWidth)); bx++) {
                const startX = bx * (blockSize + streetWidth);
                const startY = by * (blockSize + streetWidth);
                
                // Decidir tipo de edificio
                const r = Math.random();
                let buildingTiles;
                if (r < 0.3) {
                    buildingTiles = ['40', '41', '42', '43', '44']; // Pequeños
                } else if (r < 0.6) {
                    buildingTiles = ['46', '47', '48', '49', '50']; // Medianos
                } else if (r < 0.85) {
                    buildingTiles = ['52', '53', '54', '55', '56', '57']; // Grandes
                } else {
                    buildingTiles = ['45']; // Búnker
                }
                
                // Llenar el bloque
                for (let dy = 0; dy < blockSize - 1; dy++) {
                    for (let dx = 0; dx < blockSize - 1; dx++) {
                        const x = startX + dx;
                        const y = startY + dy;
                        if (this.isValidCoord(x, y)) {
                            const tile = buildingTiles[Math.floor(Math.random() * buildingTiles.length)];
                            layer[y][x] = { tileId: this.getRandomBTTile(tile) };
                        }
                    }
                }
            }
        }
        
        // Añadir escombros en algunas zonas
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                if (layer[y][x].tileId === 'bt_11' && Math.random() < 0.05) {
                    layer[y][x] = { tileId: this.getRandomBTTile('67') };
                }
            }
        }
    }
    
    /**
     * River - Río atravesando llanura
     */
    generateBTRiver() {
        const layer = this.currentMap.layers.terrain;
        
        // Base de llanura
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                layer[y][x] = { tileId: 'bt_11' };
            }
        }
        
        // Río serpenteante de arriba a abajo
        let riverX = Math.floor(this.mapWidth / 2);
        const riverTiles = ['27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37'];
        
        for (let y = 0; y < this.mapHeight; y++) {
            // Serpenteo
            riverX += Math.floor(Math.random() * 3) - 1;
            riverX = Math.max(2, Math.min(this.mapWidth - 3, riverX));
            
            // Colocar río (2-3 hexes de ancho)
            for (let dx = -1; dx <= 1; dx++) {
                const x = riverX + dx;
                if (this.isValidCoord(x, y)) {
                    const tile = riverTiles[Math.floor(Math.random() * riverTiles.length)];
                    layer[y][x] = { tileId: this.getRandomBTTile(tile) };
                }
            }
        }
        
        // Lagos en algunos puntos del río
        if (Math.random() < 0.7) {
            const lakeY = Math.floor(Math.random() * (this.mapHeight - 4)) + 2;
            this.placeBTCluster(layer, riverX, lakeY, 3, ['22', '23', '24', '25']);
        }
        
        // Bosques a los lados del río
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                if (layer[y][x].tileId === 'bt_11') {
                    const distToRiver = Math.abs(x - riverX);
                    if (distToRiver < 4 && Math.random() < 0.2) {
                        layer[y][x] = { tileId: this.getRandomBTTile('13') };
                    }
                }
            }
        }
    }
    
    /**
     * Ruins - Ruinas de batalla con escombros
     */
    generateBTRuins() {
        const layer = this.currentMap.layers.terrain;
        
        // Base mixta
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                const r = Math.random();
                if (r < 0.4) {
                    layer[y][x] = { tileId: 'bt_11' }; // Llanura
                } else if (r < 0.6) {
                    layer[y][x] = { tileId: this.getRandomBTTile('67') }; // Escombros
                } else if (r < 0.75) {
                    layer[y][x] = { tileId: this.getRandomBTTile('59') }; // Rocoso
                } else {
                    // Edificios destruidos parcialmente
                    layer[y][x] = { tileId: this.getRandomBTTile('40') };
                }
            }
        }
        
        // Cráteres (usando rocoso)
        const numCraters = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < numCraters; i++) {
            const cx = Math.floor(Math.random() * this.mapWidth);
            const cy = Math.floor(Math.random() * this.mapHeight);
            this.placeBTCluster(layer, cx, cy, 2, ['59', '60', '61', '62']);
        }
        
        // Zonas de fuego/humo
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                if (Math.random() < 0.03) {
                    layer[y][x] = { tileId: 'bt_74' }; // Humo
                }
            }
        }
    }
    
    /**
     * Desert - Desierto rocoso
     */
    generateBTDesert() {
        const layer = this.currentMap.layers.terrain;
        
        // Base de terreno rocoso/difícil
        for (let y = 0; y < this.mapHeight; y++) {
            for (let x = 0; x < this.mapWidth; x++) {
                const r = Math.random();
                if (r < 0.5) {
                    layer[y][x] = { tileId: 'bt_11' }; // Arena (llanura)
                } else if (r < 0.8) {
                    layer[y][x] = { tileId: this.getRandomBTTile('59') }; // Rocoso
                } else {
                    layer[y][x] = { tileId: this.getRandomBTTile('61') }; // Rough
                }
            }
        }
        
        // Formaciones rocosas
        const numFormations = 4 + Math.floor(Math.random() * 4);
        for (let i = 0; i < numFormations; i++) {
            const fx = Math.floor(Math.random() * this.mapWidth);
            const fy = Math.floor(Math.random() * this.mapHeight);
            this.placeBTCluster(layer, fx, fy, 2, ['59', '60', '61', '62', '63', '64']);
        }
    }
    
    /**
     * Helper: coloca un cluster de tiles en hexágonos adyacentes
     */
    placeBTCluster(layer, centerX, centerY, radius, tileOptions) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = centerX + dx;
                const y = centerY + dy;
                
                // Distancia aproximada en hex grid
                const dist = Math.abs(dx) + Math.abs(dy);
                if (dist <= radius && this.isValidCoord(x, y)) {
                    if (Math.random() < 0.7) { // No todos para variedad
                        const tile = tileOptions[Math.floor(Math.random() * tileOptions.length)];
                        layer[y][x] = { tileId: this.getRandomBTTile(tile) };
                    }
                }
            }
        }
    }
    
    // === Proyección en Display ===
    
    async projectToDisplay() {
        if (!this.currentMap) {
            showToast('No hay mapa para proyectar', 'error');
            return;
        }
        
        // Asegurar que el mapa tenga toda la información necesaria
        const mapToProject = {
            ...this.currentMap,
            gridType: this.gridType,
            systemId: this.systemId
        };
        
        try {
            console.log('📺 Proyectando mapa al display:', mapToProject.name || mapToProject.id);
            
            const response = await fetch('/api/display/project-map', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mapId: mapToProject.id, mapData: mapToProject })
            });
            
            if (response.ok) {
                showToast('✓ Mapa proyectado en display', 'success');
            } else {
                const error = await response.json();
                showToast('Error: ' + (error.detail || 'No se pudo proyectar'), 'error');
            }
        } catch (error) {
            console.error('Error proyectando mapa:', error);
            showToast('Error al proyectar: ' + error.message, 'error');
        }
    }
    
    // === Exportar/Importar ===
    
    exportMap() {
        if (!this.currentMap) return;
        
        const dataStr = JSON.stringify(this.currentMap, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `${this.currentMap.name.replace(/\s+/g, '_')}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
    }
    
    importMap(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const mapData = JSON.parse(e.target.result);
                this.currentMap = mapData;
                this.mapWidth = mapData.width;
                this.mapHeight = mapData.height;
                this.resizeCanvas();
                this.render();
                showToast(`✓ Mapa "${mapData.name}" importado`);
            } catch (error) {
                console.error('Error importando mapa:', error);
                showToast('Error al importar el mapa', 'error');
            }
        };
        reader.readAsText(file);
    }
}

// Instancia global
let mapEditor = null;
let pendingSystemReload = false; // Flag para indicar que hay que recargar al iniciar

// Inicializar cuando se cargue la pestaña del editor
function initMapEditor() {
    if (!mapEditor) {
        mapEditor = new MapEditor();
        loadSavedMapsList();
    } else if (pendingSystemReload) {
        // Si había un cambio de sistema pendiente, recargar ahora
        pendingSystemReload = false;
        reloadMapEditor();
    }
}

// Reinicializar el editor con nuevo sistema
async function reloadMapEditor() {
    if (mapEditor) {
        // Limpiar imágenes cacheadas del sistema anterior
        mapEditor.tileImages = {};
        
        // Recargar configuración del sistema y tiles
        await mapEditor.loadGameSystemConfig();
        
        if (!mapEditor.systemId) {
            mapEditor.showNoSystemMessage();
            return;
        }
        
        // Restaurar canvas si fue destruido
        mapEditor.restoreCanvas();
        
        await mapEditor.loadTileLibrary();
        await mapEditor.preloadTileImages();
        mapEditor.setupCanvas(); // Re-inicializar canvas
        mapEditor.renderTilePalette();
        mapEditor.createNewMap(mapEditor.mapWidth, mapEditor.mapHeight);
        
        // Actualizar opciones del generador
        updateMapTypeSelector(mapEditor.systemId);
        
        console.log('🔄 Editor de mapas recargado para:', mapEditor.systemId);
    } else {
        // Si el editor no existe todavía, marcar para recargar cuando se inicie
        pendingSystemReload = true;
        console.log('📌 Cambio de sistema pendiente - se aplicará al abrir el editor');
    }
}

// Actualiza el desplegable de tipos de mapa según el sistema
function updateMapTypeSelector(systemId) {
    const select = document.getElementById('gen-type');
    if (!select) return;
    
    const mapTypes = {
        battletech: [
            { value: 'bt_grasslands', label: '🌿 Llanuras' },
            { value: 'bt_forest', label: '🌲 Bosque Denso' },
            { value: 'bt_city', label: '🏙️ Ciudad' },
            { value: 'bt_river', label: '🌊 Río' },
            { value: 'bt_ruins', label: '💥 Ruinas' },
            { value: 'bt_desert', label: '🏜️ Desierto' },
            { value: 'bt_mountains', label: '⛰️ Montañas' },
        ],
        default: [
            { value: 'dungeon', label: '🏰 Mazmorra' },
            { value: 'cave', label: '🦇 Cueva' },
            { value: 'forest', label: '🌲 Bosque' },
            { value: 'town', label: '🏘️ Pueblo' },
        ]
    };
    
    const types = mapTypes[systemId] || mapTypes.default;
    
    select.innerHTML = types.map(t => 
        `<option value="${t.value}">${t.label}</option>`
    ).join('');
}

// === Funciones globales para los botones del HTML ===

function showNewMapDialog() {
    const dialog = document.createElement('div');
    dialog.className = 'map-dialog';
    dialog.innerHTML = `
        <div class="map-dialog-content">
            <h2>📄 Nuevo Mapa</h2>
            <div class="form-group">
                <label>Nombre del mapa:</label>
                <input type="text" id="new-map-name" value="Nuevo Mapa">
            </div>
            <div class="form-group">
                <label>Ancho (tiles):</label>
                <input type="number" id="new-map-width" value="20" min="10" max="50">
            </div>
            <div class="form-group">
                <label>Alto (tiles):</label>
                <input type="number" id="new-map-height" value="15" min="10" max="50">
            </div>
            <div class="form-group">
                <label>Tile de relleno:</label>
                <select id="new-map-fill">
                    <option value="grass">🟩 Hierba</option>
                    <option value="stone_floor">⬜ Piedra</option>
                    <option value="dirt">🟫 Tierra</option>
                    <option value="water">💧 Agua</option>
                </select>
            </div>
            <div class="btn-row">
                <button class="btn" onclick="this.closest('.map-dialog').remove()">Cancelar</button>
                <button class="btn btn-primary" onclick="createNewMap()">Crear</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);
    document.getElementById('new-map-name').focus();
}

function createNewMap() {
    const name = document.getElementById('new-map-name').value;
    const width = parseInt(document.getElementById('new-map-width').value);
    const height = parseInt(document.getElementById('new-map-height').value);
    const fill = document.getElementById('new-map-fill').value;
    
    if (mapEditor) {
        mapEditor.createNewMap(width, height, fill);
        mapEditor.currentMap.name = name;
        
        // Marcar que hay un mapa
        document.querySelector('.map-canvas-container')?.classList.add('has-map');
    }
    
    document.querySelector('.map-dialog')?.remove();
}

function showLoadMapDialog() {
    loadSavedMapsList();
}

async function loadSavedMapsList() {
    const listEl = document.getElementById('saved-maps-list');
    if (!listEl) return;
    
    listEl.innerHTML = '<p class="loading">Cargando...</p>';
    
    try {
        const response = await fetch('/api/maps');
        const data = await response.json();
        const maps = data.maps || [];
        
        if (maps.length === 0) {
            listEl.innerHTML = '<p class="empty-state">No hay mapas guardados</p>';
            return;
        }
        
        listEl.innerHTML = maps.map(map => `
            <div class="saved-map-item" onclick="loadMapById('${map.id}')">
                <div class="map-info">
                    <div class="map-name">${map.name || 'Sin nombre'}</div>
                    <div class="map-meta">${map.width}x${map.height} · ${map.type || 'custom'}</div>
                </div>
                <div class="map-actions">
                    <button onclick="event.stopPropagation(); loadMapById('${map.id}')" title="Cargar">📂</button>
                    <button onclick="event.stopPropagation(); projectMapById('${map.id}')" title="Proyectar">📺</button>
                    <button class="delete" onclick="event.stopPropagation(); deleteMapById('${map.id}')" title="Eliminar">🗑️</button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error cargando mapas:', error);
        listEl.innerHTML = '<p class="error">Error al cargar mapas</p>';
    }
}

async function loadMapById(mapId) {
    if (mapEditor) {
        await mapEditor.loadMap(mapId);
        document.querySelector('.map-canvas-container')?.classList.add('has-map');
    }
}

async function projectMapById(mapId) {
    try {
        const response = await fetch(`/api/maps/${mapId}/project`, {
            method: 'POST'
        });
        if (response.ok) {
            showToast('✓ Mapa proyectado', 'success');
        }
    } catch (error) {
        console.error('Error proyectando:', error);
        showToast('Error al proyectar', 'error');
    }
}

async function deleteMapById(mapId) {
    if (!confirm('¿Estás seguro de eliminar este mapa?')) return;
    
    try {
        const response = await fetch(`/api/maps/${mapId}`, {
            method: 'DELETE'
        });
        if (response.ok) {
            showToast('✓ Mapa eliminado', 'success');
            loadSavedMapsList();
        }
    } catch (error) {
        console.error('Error eliminando:', error);
        showToast('Error al eliminar', 'error');
    }
}

function generateMap() {
    const width = parseInt(document.getElementById('gen-width')?.value || 20);
    const height = parseInt(document.getElementById('gen-height')?.value || 15);
    let type = document.getElementById('gen-type')?.value || 'dungeon';
    
    console.log(`🎲 Generando mapa: ${width}x${height} tipo: ${type}`);
    
    if (!mapEditor || !mapEditor.systemId) {
        showToast('⚠️ Selecciona un sistema de juego primero', 'error');
        return;
    }
    
    // Si es BattleTech y eligieron un tipo de D&D, usar llanuras por defecto
    if (mapEditor.systemId === 'battletech' && !type.startsWith('bt_')) {
        type = 'bt_grasslands';
        console.log('🔄 Cambiando a tipo BattleTech:', type);
    }
    
    console.log('Sistema:', mapEditor.systemId);
    console.log('Tiles cargados:', Object.keys(mapEditor.tiles).length);
    
    mapEditor.generateLocalMap(width, height, type);
    document.querySelector('.map-canvas-container')?.classList.add('has-map');
    showToast(`🎲 Mapa ${type} generado`, 'success');
}

// Helper para mostrar notificaciones
function showToast(message, type = 'info') {
    // Usar el sistema de toast existente si hay, o crear uno simple
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 12px 20px;
        background: ${type === 'success' ? '#22c55e' : type === 'error' ? '#ef4444' : '#6366f1'};
        color: white;
        border-radius: 8px;
        z-index: 10000;
        animation: slideIn 0.3s ease;
    `;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Inicializar cuando se selecciona la pestaña de mapas
document.addEventListener('DOMContentLoaded', () => {
    // Detectar cuando se cambia a la pestaña de mapas
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            if (mutation.target.id === 'tab-maps' && 
                mutation.target.classList.contains('active')) {
                initMapEditor();
            }
        });
    });
    
    const tabMaps = document.getElementById('tab-maps');
    if (tabMaps) {
        observer.observe(tabMaps, { attributes: true, attributeFilter: ['class'] });
    }
});
