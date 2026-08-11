/**
 * MesaRPG - Renderer de Mapa y Tokens
 * Dibuja el mapa, personajes y elementos del juego
 * Optimizado para pantallas táctiles
 */

class GameRenderer {
    constructor() {
        this.mapCanvas = document.getElementById('map-canvas');
        this.mapCtx = this.mapCanvas.getContext('2d');
        this.tokensContainer = document.getElementById('tokens-container');
        
        this.currentMap = null;
        this.characters = {};
        this.tokens = {};
        this.selectedCharacterId = null;
        
        this.gridSize = 50; // Tamaño de celda en píxeles (se recalcula según pantalla)
        this.showGrid = true;
        this.gridType = 'hexagonal'; // 'hexagonal' o 'square'
        
        // Configuración de pantalla para grid de 1 pulgada
        this.screenConfig = {
            dpi: 96,              // DPI detectado o configurado
            diagonalInches: 24,   // Tamaño diagonal en pulgadas
            pixelsPerInch: 96,    // Píxeles por pulgada calculados
            targetGridInches: 1   // Tamaño objetivo de cada celda en pulgadas
        };
        
        // Detectar configuración de pantalla
        this.detectScreenConfig();
        
        // Estado de arrastre
        this.dragging = null; // { tokenId, offsetX, offsetY }
        this.longPressTimer = null;
        this.longPressPos = null;
        
        // Contador para IDs únicos de tokens locales
        this.localTokenCounter = 0;

        // Índice de tokens visuales (id -> ruta de archivo), para resolver token_visual
        this.tokenLibrary = null;
        this.loadTokenLibrary();
        
        // Calibración inicial (sin transformación)
        this.calibration = {
            offsetX: 0,
            offsetY: 0,
            scaleX: 1,
            scaleY: 1
        };
        
        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        // Inicializar eventos táctiles (solo si no están deshabilitados)
        if (!window.DISABLE_RENDERER_TOUCH) {
            this.setupTouchEvents();
        } else {
            console.log('🖐️ Eventos táctiles del renderer deshabilitados (usando sistema multitouch)');
        }
    }
    
    // Detectar configuración de pantalla para calcular píxeles por pulgada
    detectScreenConfig() {
        // Obtener resolución FÍSICA de pantalla (multiplicando por devicePixelRatio)
        const dpr = window.devicePixelRatio || 1;
        const physicalWidth = window.screen.width * dpr;
        const physicalHeight = window.screen.height * dpr;
        
        // Cargar configuración guardada o usar valores por defecto
        const savedConfig = localStorage.getItem('mesarpg_screen_config');
        if (savedConfig) {
            try {
                const config = JSON.parse(savedConfig);
                this.screenConfig = { ...this.screenConfig, ...config };
            } catch (e) {
                console.warn('Error cargando configuración de pantalla:', e);
            }
        }
        
        // Calcular píxeles por pulgada basado en diagonal configurada
        this.calculatePixelsPerInch();
        
        // Recalcular tamaño de grid
        this.updateGridSize();
        
        console.log(`📺 Pantalla: ${physicalWidth}x${physicalHeight} física, DPR: ${dpr}, Grid: ${this.gridSize}px CSS`);
    }
    
    // Calcular píxeles CSS por pulgada basado en la diagonal configurada
    calculatePixelsPerInch() {
        const dpr = window.devicePixelRatio || 1;
        
        // Resolución FÍSICA de pantalla
        const physicalWidth = window.screen.width * dpr;
        const physicalHeight = window.screen.height * dpr;
        
        // Diagonal en píxeles FÍSICOS
        const diagonalPhysicalPixels = Math.sqrt(physicalWidth * physicalWidth + physicalHeight * physicalHeight);
        
        // PPI físico (píxeles físicos por pulgada)
        const physicalPPI = diagonalPhysicalPixels / this.screenConfig.diagonalInches;
        
        // PPI en CSS (dividir por devicePixelRatio porque la grid se dibuja en píxeles CSS)
        this.screenConfig.pixelsPerInch = physicalPPI / dpr;
        
        console.log(`📐 Diagonal: ${this.screenConfig.diagonalInches}" | PPI físico: ${physicalPPI.toFixed(1)} | PPI CSS: ${this.screenConfig.pixelsPerInch.toFixed(1)} (DPR: ${dpr})`);
    }
    
    // Actualizar tamaño de grid para que sea 1 pulgada real
    updateGridSize() {
        this.gridSize = Math.round(this.screenConfig.pixelsPerInch * this.screenConfig.targetGridInches);
        
        // Mínimo y máximo razonable
        this.gridSize = Math.max(30, Math.min(200, this.gridSize));
        
        console.log(`📏 Grid size: ${this.gridSize}px = ${this.screenConfig.targetGridInches}" real`);
    }
    
    // Configurar tamaño de pantalla en pulgadas (llamado desde UI de calibración)
    setScreenSize(diagonalInches) {
        this.screenConfig.diagonalInches = diagonalInches;
        this.calculatePixelsPerInch();
        this.updateGridSize();
        
        // Guardar configuración
        localStorage.setItem('mesarpg_screen_config', JSON.stringify(this.screenConfig));
        
        // Redibujar
        this.redraw();
        
        console.log(`✅ Pantalla configurada: ${diagonalInches}" diagonal, grid ${this.gridSize}px`);
    }
    
    // Configurar tamaño objetivo de grid en pulgadas
    setGridTargetSize(inches) {
        this.screenConfig.targetGridInches = inches;
        this.updateGridSize();
        
        // Guardar configuración
        localStorage.setItem('mesarpg_screen_config', JSON.stringify(this.screenConfig));
        
        // Redibujar
        this.redraw();
    }
    
    // Obtener información de pantalla para mostrar en UI
    getScreenInfo() {
        const dpr = window.devicePixelRatio || 1;
        const physicalWidth = window.screen.width * dpr;
        const physicalHeight = window.screen.height * dpr;
        
        return {
            resolution: `${physicalWidth}x${physicalHeight}`,
            cssResolution: `${window.screen.width}x${window.screen.height}`,
            devicePixelRatio: dpr,
            diagonalInches: this.screenConfig.diagonalInches,
            pixelsPerInch: this.screenConfig.pixelsPerInch.toFixed(1),
            gridSizePixels: this.gridSize,
            gridSizeInches: this.screenConfig.targetGridInches
        };
    }
    
    setupTouchEvents() {
        if (!this.tokensContainer) {
            console.error('❌ tokens-container no encontrado!');
            return;
        }
        
        console.log('🖐️ Configurando eventos táctiles...');
        
        // Mostrar mensaje de debug en pantalla
        this.showDebugMessage('Touch habilitado - toca para crear token');
        
        // IMPORTANTE: Usar document.body como fallback
        const target = this.tokensContainer;
        
        // Touch events
        target.addEventListener('touchstart', (e) => {
            this.showDebugMessage('touchstart: ' + e.touches[0].clientX + ',' + e.touches[0].clientY);
            this.handleTouchStart(e);
        }, { passive: false });
        
        target.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        
        target.addEventListener('touchend', (e) => {
            if (e.changedTouches.length > 0) {
                const touch = e.changedTouches[0];
                this.showDebugMessage('touchend: ' + touch.clientX + ',' + touch.clientY);
                
                // Crear token si no estábamos arrastrando
                if (!this.dragging) {
                    const tokenEl = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.character-token');
                    if (!tokenEl) {
                        this.createLocalToken(touch.clientX, touch.clientY);
                    }
                }
            }
            this.handleTouchEnd(e);
        }, { passive: false });
        
        target.addEventListener('touchcancel', (e) => this.handleTouchEnd(e), { passive: false });
        
        // Mouse events (para debug en PC)
        target.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        target.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        target.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        target.addEventListener('mouseleave', (e) => this.handleMouseUp(e));
        
        // Click para crear token
        target.addEventListener('click', (e) => {
            this.showDebugMessage('click: ' + e.clientX + ',' + e.clientY);
            const tokenEl = e.target.closest('.character-token');
            if (!tokenEl) {
                this.createLocalToken(e.clientX, e.clientY);
            }
        });
        
        console.log('✅ Eventos táctiles configurados');
    }
    
    showDebugMessage(msg) {
        console.log('🔵 ' + msg);
        // Mostrar en pantalla temporalmente
        let debugEl = document.getElementById('touch-debug');
        if (!debugEl) {
            debugEl = document.createElement('div');
            debugEl.id = 'touch-debug';
            debugEl.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.8);color:#0f0;padding:10px 20px;border-radius:5px;z-index:9999;font-family:monospace;';
            document.body.appendChild(debugEl);
        }
        debugEl.textContent = msg;
        // Ocultar después de 3 segundos
        clearTimeout(this.debugTimeout);
        this.debugTimeout = setTimeout(() => {
            if (debugEl) debugEl.style.display = 'none';
        }, 3000);
        debugEl.style.display = 'block';
    }
    
    handleTouchStart(e) {
        console.log('👆 Touch start:', e.touches.length, 'toques');
        if (e.touches.length !== 1) return;
        
        const touch = e.touches[0];
        const x = touch.clientX;
        const y = touch.clientY;
        
        // Verificar si tocamos un token
        const tokenEl = document.elementFromPoint(x, y)?.closest('.character-token');
        
        if (tokenEl) {
            // Iniciar arrastre del token
            e.preventDefault();
            const charId = tokenEl.dataset.characterId;
            const rect = tokenEl.getBoundingClientRect();
            
            this.dragging = {
                tokenId: charId,
                offsetX: x - (rect.left + rect.width / 2),
                offsetY: y - (rect.top + rect.height / 2)
            };
            
            tokenEl.classList.add('dragging');
            this.selectCharacter(charId);
            console.log('🎯 Iniciando arrastre de:', charId);
        } else {
            // Toque en espacio vacío - iniciar long press para crear token
            this.longPressPos = { x, y };
            this.longPressTimer = setTimeout(() => {
                this.createLocalToken(x, y);
                this.longPressPos = null;
            }, 500); // 500ms para long press
        }
    }
    
    handleTouchMove(e) {
        // Cancelar long press si se mueve
        if (this.longPressTimer && this.longPressPos) {
            const touch = e.touches[0];
            const dx = touch.clientX - this.longPressPos.x;
            const dy = touch.clientY - this.longPressPos.y;
            if (Math.sqrt(dx*dx + dy*dy) > 10) {
                clearTimeout(this.longPressTimer);
                this.longPressTimer = null;
            }
        }
        
        // Arrastrar token
        if (this.dragging && e.touches.length === 1) {
            e.preventDefault();
            const touch = e.touches[0];
            const x = touch.clientX - this.dragging.offsetX;
            const y = touch.clientY - this.dragging.offsetY;
            
            this.moveToken(this.dragging.tokenId, x, y);
        }
    }
    
    handleTouchEnd(e) {
        // Cancelar long press
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        
        // Finalizar arrastre
        if (this.dragging) {
            const token = this.tokens[this.dragging.tokenId];
            if (token) {
                token.classList.remove('dragging');
            }
            
            // Notificar al servidor la nueva posición
            this.notifyPositionChange(this.dragging.tokenId);
            
            console.log('✅ Arrastre finalizado:', this.dragging.tokenId);
            this.dragging = null;
        }
    }
    
    // === Eventos de Mouse (para desarrollo) ===
    
    handleMouseDown(e) {
        if (e.button !== 0) return; // Solo click izquierdo
        
        const tokenEl = e.target.closest('.character-token');
        
        if (tokenEl) {
            e.preventDefault();
            const charId = tokenEl.dataset.characterId;
            const rect = tokenEl.getBoundingClientRect();
            
            this.dragging = {
                tokenId: charId,
                offsetX: e.clientX - (rect.left + rect.width / 2),
                offsetY: e.clientY - (rect.top + rect.height / 2)
            };
            
            tokenEl.classList.add('dragging');
            this.selectCharacter(charId);
        }
    }
    
    handleMouseMove(e) {
        if (this.dragging) {
            e.preventDefault();
            const x = e.clientX - this.dragging.offsetX;
            const y = e.clientY - this.dragging.offsetY;
            
            this.moveToken(this.dragging.tokenId, x, y);
        }
    }
    
    handleMouseUp(e) {
        if (this.dragging) {
            const token = this.tokens[this.dragging.tokenId];
            if (token) {
                token.classList.remove('dragging');
            }
            
            this.notifyPositionChange(this.dragging.tokenId);
            this.dragging = null;
        }
    }
    
    // === Mover y crear tokens ===
    
    moveToken(tokenId, x, y) {
        const token = this.tokens[tokenId];
        if (!token) return;
        
        token.style.left = `${x}px`;
        token.style.top = `${y}px`;
        
        // Actualizar estado local
        if (this.characters[tokenId]) {
            this.characters[tokenId].position = { x, y, rotation: 0 };
        }
    }
    
    createLocalToken(x, y) {
        this.showDebugMessage('Creando token en ' + x + ',' + y);
        
        // Crear un token local (sin servidor)
        this.localTokenCounter++;
        const localId = `local_${this.localTokenCounter}`;
        
        const names = ['Guerrero', 'Mago', 'Arquera', 'Clérigo', 'Pícaro', 'Bárbaro', 'Druida', 'Paladín'];
        const classes = ['Guerrero', 'Mago', 'Ranger', 'Clérigo', 'Pícaro', 'Bárbaro', 'Druida', 'Paladín'];
        const idx = (this.localTokenCounter - 1) % names.length;
        
        const char = {
            id: localId,
            name: names[idx],
            character_class: classes[idx],
            hp: 100,
            max_hp: 100,
            position: { x, y, rotation: 0 }
        };
        
        this.characters[localId] = char;
        
        try {
            this.createToken(localId, char);
            console.log('✨ Token local creado:', char.name, 'en', x, y);
            this.showDebugMessage('Token: ' + char.name + ' creado!');
        } catch (e) {
            console.error('Error creando token:', e);
            this.showDebugMessage('ERROR: ' + e.message);
        }
        
        // Notificar al servidor (si está conectado)
        this.notifyTokenCreated(localId, char);
        
        // Feedback visual
        this.showTouchFeedback(x, y);
    }
    
    showTouchFeedback(x, y) {
        const feedback = document.createElement('div');
        feedback.className = 'touch-feedback';
        feedback.style.cssText = `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            border: 3px solid #4ecdc4;
            transform: translate(-50%, -50%) scale(0);
            animation: touchPulse 0.5s ease-out forwards;
            pointer-events: none;
        `;
        this.tokensContainer.appendChild(feedback);
        setTimeout(() => feedback.remove(), 500);
    }
    
    notifyPositionChange(tokenId) {
        // Enviar al servidor la nueva posición
        if (window.wsManager && window.wsManager.isConnected) {
            const char = this.characters[tokenId];
            if (char && char.position) {
                window.wsManager.send('character_move', {
                    character_id: tokenId,
                    position: char.position
                });
            }
        }
    }
    
    notifyTokenCreated(tokenId, char) {
        // Notificar al servidor que se creó un token
        if (window.wsManager && window.wsManager.isConnected) {
            window.wsManager.send('character_create', {
                id: tokenId,
                name: char.name,
                character_class: char.character_class,
                position: char.position
            });
        }
    }
    
    resize() {
        this.mapCanvas.width = window.innerWidth;
        this.mapCanvas.height = window.innerHeight;
        this.redraw();
    }
    
    // === Mapa ===
    
    loadMap(mapId) {
        console.log('🗺️ Cargando mapa:', mapId);
        this.currentMap = mapId;
        this.mapData = null; // Limpiar datos de mapa anterior
        
        const mapImage = new Image();
        mapImage.onload = () => {
            this.mapImage = mapImage;
            this.redraw();
        };
        mapImage.onerror = () => {
            console.log('No se encontró imagen del mapa, usando fondo por defecto');
            this.mapImage = null;
            this.redraw();
        };
        mapImage.src = `assets/maps/${mapId}.png`;
    }
    
    /**
     * Carga un mapa con datos completos (tiles, elevación, etc.)
     * Usado cuando el admin proyecta un mapa editado
     */
    loadMapData(mapData) {
        console.log('🗺️ Cargando datos de mapa:', mapData.name || mapData.id);
        
        this.mapData = mapData;
        this.mapImage = null; // No usar imagen, dibujar desde datos
        this.currentMap = mapData.id;
        
        // Configurar tipo de grid según el mapa
        if (mapData.gridType === 'hex') {
            this.gridType = 'hexagonal';
        } else {
            this.gridType = 'square';
        }
        
        // Precargar imágenes de tiles
        this.preloadMapTiles(mapData);
        
        this.redraw();
    }
    
    /**
     * Precarga las imágenes de tiles del mapa
     */
    async preloadMapTiles(mapData) {
        if (!mapData?.layers?.terrain) return;
        
        const tileIds = new Set();
        
        // Recopilar todos los tile IDs únicos
        for (const row of mapData.layers.terrain) {
            for (const cell of row) {
                if (cell?.tileId) {
                    tileIds.add(cell.tileId);
                }
            }
        }
        
        // Cargar imágenes
        if (!this.tileImages) this.tileImages = {};
        
        for (const tileId of tileIds) {
            if (!this.tileImages[tileId]) {
                const img = new Image();
                const filename = tileId.replace('bt_', '');
                img.src = `/assets/tiles/battletech_singles/${filename}.png`;
                this.tileImages[tileId] = img;
            }
        }
        
        // Redibujar cuando las imágenes carguen
        setTimeout(() => this.redraw(), 100);
        setTimeout(() => this.redraw(), 500);
    }
    
    redraw() {
        const ctx = this.mapCtx;
        const w = this.mapCanvas.width;
        const h = this.mapCanvas.height;
        
        // Limpiar
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, w, h);
        
        // Si hay datos de mapa, dibujar desde tiles
        if (this.mapData?.layers?.terrain) {
            this.drawMapFromData(ctx, w, h);
        }
        // Si hay imagen del mapa, usarla
        else if (this.mapImage) {
            ctx.drawImage(this.mapImage, 0, 0, w, h);
        } else {
            // Fondo por defecto con patrón
            this.drawDefaultBackground(ctx, w, h);
            
            // Dibujar grid si está activo
            if (this.showGrid) {
                this.drawGrid(ctx, w, h);
            }
        }
    }
    
    /**
     * Dibuja el mapa desde datos de tiles, centrado en pantalla
     */
    drawMapFromData(ctx, screenW, screenH) {
        const mapData = this.mapData;
        const terrain = mapData.layers.terrain;
        
        // Calcular tamaño de hex basado en gridSize (1 pulgada)
        const hexRadius = this.gridSize / 2;
        const hexWidth = hexRadius * 2;
        const hexHeight = Math.sqrt(3) * hexRadius;
        
        // Dimensiones del mapa en píxeles
        const horizSpacing = hexWidth * 0.75;
        const vertSpacing = hexHeight;
        
        const mapPixelWidth = (mapData.width - 1) * horizSpacing + hexWidth;
        const mapPixelHeight = (mapData.height - 1) * vertSpacing + hexHeight + hexHeight / 2;
        
        // Calcular offset para centrar el mapa
        const offsetX = (screenW - mapPixelWidth) / 2;
        const offsetY = (screenH - mapPixelHeight) / 2;
        
        // PASADA 1: Dibujar todas las tiles (sin bordes)
        for (let y = 0; y < mapData.height; y++) {
            for (let x = 0; x < mapData.width; x++) {
                const cell = terrain[y]?.[x];
                if (!cell) continue;
                
                const hexOffsetY = (x % 2 === 1) ? hexHeight / 2 : 0;
                const cx = offsetX + x * horizSpacing + hexRadius;
                const cy = offsetY + hexOffsetY + y * vertSpacing + hexHeight / 2;
                
                this.drawHexTile(ctx, cx, cy, hexRadius, cell);
            }
        }
        
        // PASADA 2: Dibujar grid encima de todas las tiles
        ctx.strokeStyle = 'rgba(60,60,60,0.4)';
        ctx.lineWidth = 1;
        for (let y = 0; y < mapData.height; y++) {
            for (let x = 0; x < mapData.width; x++) {
                const cell = terrain[y]?.[x];
                if (!cell) continue;
                
                const hexOffsetY = (x % 2 === 1) ? hexHeight / 2 : 0;
                const cx = offsetX + x * horizSpacing + hexRadius;
                const cy = offsetY + hexOffsetY + y * vertSpacing + hexHeight / 2;
                
                // Dibujar borde hexagonal
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const angle = (Math.PI / 3) * i;
                    const hx = cx + hexRadius * Math.cos(angle);
                    const hy = cy + hexRadius * Math.sin(angle);
                    if (i === 0) ctx.moveTo(hx, hy);
                    else ctx.lineTo(hx, hy);
                }
                ctx.closePath();
                ctx.stroke();
            }
        }
        
        // PASADA 3: Dibujar elevaciones encima
        for (let y = 0; y < mapData.height; y++) {
            for (let x = 0; x < mapData.width; x++) {
                const cell = terrain[y]?.[x];
                if (!cell || !cell.elevation || cell.elevation <= 0) continue;
                
                const hexOffsetY = (x % 2 === 1) ? hexHeight / 2 : 0;
                const cx = offsetX + x * horizSpacing + hexRadius;
                const cy = offsetY + hexOffsetY + y * vertSpacing + hexHeight / 2;
                
                this.drawElevationBadge(ctx, cx, cy, hexRadius, cell.elevation);
            }
        }
    }
    
    /**
     * Dibuja indicador de elevación
     */
    drawElevationBadge(ctx, cx, cy, radius, elevation) {
        const fontSize = Math.max(10, radius * 0.4);
        const textX = cx + radius * 0.45;
        const textY = cy - radius * 0.45;
        
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.arc(textX, textY, fontSize * 0.7, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.font = `bold ${fontSize}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(elevation.toString(), textX, textY);
    }
    
    /**
     * Dibuja un tile hexagonal
     */
    drawHexTile(ctx, cx, cy, radius, cell) {
        const tileId = cell.tileId;
        const elevation = cell.elevation || 0;
        
        // Intentar usar imagen del tile
        const img = this.tileImages?.[tileId];
        
        if (img && img.complete && img.naturalWidth > 0) {
            // Clip hexagonal con overlap para seamless
            ctx.save();
            const clipRadius = radius * 1.03; // 3% más grande para overlap
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i;
                const hx = cx + clipRadius * Math.cos(angle);
                const hy = cy + clipRadius * Math.sin(angle);
                if (i === 0) ctx.moveTo(hx, hy);
                else ctx.lineTo(hx, hy);
            }
            ctx.closePath();
            ctx.clip();
            
            // Dibujar imagen
            const imgSize = radius * 2.2;
            ctx.drawImage(img, cx - imgSize/2, cy - imgSize/2, imgSize, imgSize);
            ctx.restore();
        } else {
            // Fallback: color según tipo de tile
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i;
                const hx = cx + radius * Math.cos(angle);
                const hy = cy + radius * Math.sin(angle);
                if (i === 0) ctx.moveTo(hx, hy);
                else ctx.lineTo(hx, hy);
            }
            ctx.closePath();
            
            // Color según tipo
            const colors = {
                'bt_11': '#4a7c23',      // Llanura
                'bt_27': '#2196f3',       // Agua
                'bt_28': '#1976d2',
                'bt_29': '#1565c0',
                'bt_30': '#0d47a1',
                'default': '#3d3d3d'
            };
            ctx.fillStyle = colors[tileId] || colors.default;
            ctx.fill();
        }
    }
    
    drawDefaultBackground(ctx, w, h) {
        // Gradiente de fondo oscuro
        const gradient = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, Math.max(w, h)/2);
        gradient.addColorStop(0, '#2a2a4a');
        gradient.addColorStop(1, '#1a1a2e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
    }
    
    drawGrid(ctx, w, h) {
        if (this.gridType === 'square') {
            this.drawSquareGrid(ctx, w, h);
        } else {
            this.drawHexGrid(ctx, w, h);
        }
    }
    
    drawSquareGrid(ctx, w, h) {
        const cellSize = this.gridSize;
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        
        // Líneas verticales
        for (let x = 0; x <= w; x += cellSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        
        // Líneas horizontales
        for (let y = 0; y <= h; y += cellSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
    }
    
    drawHexGrid(ctx, w, h) {
        // Hexágonos flat-top (lado plano arriba) - tamaño basado en gridSize (1 pulgada)
        const size = this.gridSize / 2; // Radio del hexágono (la mitad del gridSize)
        
        // Dimensiones de un hexágono flat-top
        const hexWidth = size * 2;              // Ancho = 2 * radio
        const hexHeight = Math.sqrt(3) * size;  // Alto = sqrt(3) * radio
        
        // Espaciado entre centros
        const horizSpacing = hexWidth * 0.75;   // Horizontal: 3/4 de ancho
        const vertSpacing = hexHeight;          // Vertical: alto completo
        
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.25)';
        ctx.lineWidth = 2;
        
        let col = 0;
        for (let x = size; x < w + hexWidth; x += horizSpacing) {
            // Columnas impares se desplazan medio hexágono hacia abajo
            const offsetY = (col % 2 === 1) ? hexHeight / 2 : 0;
            
            for (let y = offsetY + hexHeight / 2; y < h + hexHeight; y += vertSpacing) {
                this.drawHexagon(ctx, x, y, size);
            }
            col++;
        }
    }
    
    drawHexagon(ctx, cx, cy, size) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            // Flat-top: empieza desde derecha (ángulo 0°)
            const angle = (Math.PI / 3) * i;
            const x = cx + size * Math.cos(angle);
            const y = cy + size * Math.sin(angle);
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.closePath();
        ctx.stroke();
    }
    
    // Cambiar el tipo de grid según el sistema de juego
    setGridType(gridType) {
        // Normalizar: 'hex' y 'hexagonal' ambos son hexagonales
        if (gridType === 'hex' || gridType === 'hexagonal') {
            this.gridType = 'hexagonal';
        } else if (gridType === 'square') {
            this.gridType = 'square';
        } else {
            this.gridType = 'hexagonal'; // Por defecto
        }
        console.log(`🎲 Grid cambiada a: ${this.gridType}`);
        this.redraw();
    }
    
    // Configurar sistema de juego (llamado desde app.js)
    // Solo cambia el TIPO de grid, NO el tamaño (el tamaño viene de la calibración de pantalla)
    setGameSystem(systemConfig) {
        if (systemConfig && systemConfig.grid) {
            this.setGridType(systemConfig.grid.type || systemConfig.gridType);
            // NO sobrescribir gridSize - se mantiene el calculado por la calibración de pantalla
        } else if (systemConfig && systemConfig.gridType) {
            this.setGridType(systemConfig.gridType);
        }
    }
    
    // === Tokens de personajes ===
    
    updateCharacters(characters) {
        this.characters = characters;
        
        // Crear/actualizar tokens
        for (const [id, char] of Object.entries(characters)) {
            if (this.tokens[id]) {
                this.updateToken(id, char);
            } else {
                this.createToken(id, char);
            }
        }
        
        // Eliminar tokens de personajes que ya no existen
        for (const id of Object.keys(this.tokens)) {
            if (!characters[id]) {
                this.removeToken(id);
            }
        }
    }
    
    async loadTokenLibrary() {
        /**
         * Carga el índice de tokens visuales (assets/markers/tokens.json) y construye
         * un mapa id -> ruta de archivo. token_visual en las fichas guarda solo el id
         * del token, no una ruta de imagen, así que hay que resolverlo contra este índice.
         */
        try {
            const response = await fetch('/assets/markers/tokens.json');
            const data = await response.json();
            const allTokens = [
                ...(data.dnd || []),
                ...(data.battletech || []),
                ...(data.generic || [])
            ];
            this.tokenLibrary = {};
            allTokens.forEach(token => {
                this.tokenLibrary[token.id] = token.file;
            });
        } catch (error) {
            console.warn('No se pudo cargar el índice de tokens:', error);
            this.tokenLibrary = {};
        }

        // Si ya se habían creado tokens de miniatura antes de que cargara el índice
        // (condición de carrera al arrancar), recrearlos para que muestren la imagen correcta.
        if (this.miniatureAssignments && this.miniatureCharacters) {
            this.updateMiniatureAssignments(this.miniatureAssignments, this.miniatureCharacters);
        }
    }

    resolveTokenImage(tokenVisualId) {
        /** Convierte un id de token_visual en la ruta de imagen real, o null si no se conoce. */
        if (!tokenVisualId) return null;
        const file = this.tokenLibrary?.[tokenVisualId];
        return file ? `/assets/markers/${file}` : null;
    }

    createToken(id, char) {
        console.log('🎭 Creando token:', char.name, 'contenedor:', this.tokensContainer);
        
        if (!this.tokensContainer) {
            console.error('❌ tokensContainer no existe!');
            this.tokensContainer = document.getElementById('tokens-container');
            if (!this.tokensContainer) {
                console.error('❌ No se puede encontrar tokens-container en el DOM');
                return;
            }
        }
        
        const token = document.createElement('div');
        token.className = 'character-token';
        token.id = `token-${id}`;
        token.dataset.characterId = id;
        
        // Posición directa en el estilo (sin calibración para tokens locales)
        token.style.left = `${char.position.x}px`;
        token.style.top = `${char.position.y}px`;
        token.style.position = 'absolute';
        
        token.innerHTML = `
            <span class="token-name">${char.name}</span>
            <div class="token-inner">
                <div class="token-placeholder">${char.name.charAt(0)}</div>
            </div>
            <div class="token-hp-bar">
                <div class="token-hp-fill" style="width: ${(char.hp / char.max_hp) * 100}%"></div>
            </div>
            <div class="token-class">${char.character_class || char.class || ''}</div>
        `;
        
        // Intentar cargar imagen solo si tiene marker_id válido
        if (char.marker_id !== undefined && char.marker_id !== null) {
            const img = new Image();
            img.onload = () => {
                const inner = token.querySelector('.token-inner');
                inner.innerHTML = '';
                img.className = 'token-image';
                inner.appendChild(img);
            };
            img.src = `assets/tokens/${char.marker_id}.png`;
        }
        
        // Añadir al DOM primero
        this.tokensContainer.appendChild(token);
        this.tokens[id] = token;
        
        console.log('✅ Token añadido al DOM:', token, 'en', char.position.x, char.position.y);
        
        // Eventos táctiles y click
        token.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectCharacter(id);
        });
        token.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            this.selectCharacter(id);
        }, { passive: true });
        
        // Animación de entrada
        token.style.animation = 'tokenAppear 0.3s ease-out';
    }
    
    setTokenPosition(token, position) {
        if (position) {
            // Aplicar calibración de la cámara
            const x = (position.x * this.calibration.scaleX) + this.calibration.offsetX;
            const y = (position.y * this.calibration.scaleY) + this.calibration.offsetY;
            
            token.style.left = `${x}px`;
            token.style.top = `${y}px`;
            
            // Aplicar rotación si está definida
            if (position.rotation !== undefined) {
                token.style.transform = `translate(-50%, -50%) rotate(${position.rotation}deg)`;
            }
        } else {
            // Posición por defecto
            token.style.left = '100px';
            token.style.top = '100px';
        }
    }
    
    updateToken(id, char) {
        const token = this.tokens[id];
        if (!token) return;
        
        // Actualizar posición en tiempo real (para tracking de marcadores)
        this.setTokenPosition(token, char.position);
        
        // Actualizar HP
        const hpBar = token.querySelector('.token-hp-fill');
        const hpPercent = (char.hp / char.max_hp) * 100;
        hpBar.style.width = `${hpPercent}%`;
        hpBar.classList.toggle('low', hpPercent < 30);
        
        // Actualizar estados
        token.classList.toggle('dead', char.hp <= 0);
        token.classList.toggle('poisoned', char.status_effects?.includes('poison'));
        token.classList.toggle('burning', char.status_effects?.includes('burning'));
    }
    
    removeToken(id) {
        const token = this.tokens[id];
        if (token) {
            token.remove();
            delete this.tokens[id];
        }
    }
    
    setActiveCharacter(characterId) {
        // Quitar clase active de todos
        Object.values(this.tokens).forEach(t => t.classList.remove('active'));
        
        // Añadir a nuevo activo
        if (characterId && this.tokens[characterId]) {
            this.tokens[characterId].classList.add('active');
        }
    }
    
    selectCharacter(characterId) {
        this.selectedCharacterId = characterId;
        
        // Mostrar info del personaje
        if (characterId && this.characters[characterId]) {
            this.showCharacterInfo(this.characters[characterId]);
        } else {
            this.hideCharacterInfo();
        }
        
        // Emitir evento
        window.dispatchEvent(new CustomEvent('characterSelected', { 
            detail: { characterId } 
        }));
    }
    
    // === UI de personaje ===
    
    showCharacterInfo(char) {
        const panel = document.getElementById('character-info');
        panel.classList.remove('hidden');
        
        document.getElementById('char-name').textContent = char.name;
        document.getElementById('char-class').textContent = char.character_class || char.class;
        
        const hpPercent = (char.hp / char.max_hp) * 100;
        document.getElementById('char-hp-bar').style.width = `${hpPercent}%`;
        document.getElementById('char-hp-text').textContent = `${char.hp}/${char.max_hp}`;
        
        const manaPercent = (char.mana / char.max_mana) * 100;
        document.getElementById('char-mana-bar').style.width = `${manaPercent}%`;
        document.getElementById('char-mana-text').textContent = `${char.mana}/${char.max_mana}`;
        
        // Habilidades
        const abilitiesContainer = document.getElementById('char-abilities');
        abilitiesContainer.innerHTML = char.abilities.map(a => 
            `<span class="ability-badge">${a}</span>`
        ).join('');
    }
    
    hideCharacterInfo() {
        document.getElementById('character-info').classList.add('hidden');
    }
    
    // === Panel de combate ===
    
    updateCombatPanel(state) {
        const panel = document.getElementById('combat-panel');
        const turnIndicator = document.getElementById('turn-indicator');
        
        if (state.is_combat) {
            panel.classList.remove('hidden');
            turnIndicator.classList.remove('hidden');
            
            document.getElementById('turn-number').textContent = `Turno ${state.current_turn}`;
            
            const activeChar = state.characters[state.active_character_id];
            document.getElementById('active-character').textContent = 
                activeChar ? activeChar.name : '-';
            
            // Lista de iniciativa
            const initList = document.getElementById('initiative-list');
            initList.innerHTML = state.initiative_order.map(charId => {
                const char = state.characters[charId];
                if (!char) return '';
                
                const isActive = charId === state.active_character_id;
                return `
                    <div class="initiative-entry ${isActive ? 'active' : ''}">
                        <div class="init-portrait">${char.name.charAt(0)}</div>
                        <span class="init-name">${char.name}</span>
                        <span class="init-hp">${char.hp}/${char.max_hp}</span>
                    </div>
                `;
            }).join('');
            
            this.setActiveCharacter(state.active_character_id);
        } else {
            panel.classList.add('hidden');
            turnIndicator.classList.add('hidden');
            this.setActiveCharacter(null);
        }
    }
    
    // === Log de acciones ===
    
    addLogEntry(message, type = 'normal') {
        const logEntries = document.getElementById('log-entries');
        
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = message;
        
        logEntries.appendChild(entry);
        
        // Auto-scroll
        logEntries.scrollTop = logEntries.scrollHeight;
        
        // Limitar entradas
        while (logEntries.children.length > 20) {
            logEntries.removeChild(logEntries.firstChild);
        }
    }
    
    // === Indicadores de rango/área ===
    
    showRangeIndicator(x, y, range, color = 'rgba(255, 255, 255, 0.2)') {
        const indicator = document.createElement('div');
        indicator.className = 'range-indicator';
        indicator.style.cssText = `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            width: ${range * 2}px;
            height: ${range * 2}px;
            border-radius: 50%;
            border: 2px dashed ${color};
            transform: translate(-50%, -50%);
            pointer-events: none;
        `;
        
        this.tokensContainer.appendChild(indicator);
        return indicator;
    }
    
    removeRangeIndicator(indicator) {
        if (indicator && indicator.parentNode) {
            indicator.remove();
        }
    }
    
    // === Calibración de cámara ===
    
    setCalibration(offsetX, offsetY, scaleX, scaleY) {
        this.calibration = {
            offsetX: offsetX || 0,
            offsetY: offsetY || 0,
            scaleX: scaleX || 1,
            scaleY: scaleY || 1
        };
        console.log('📐 Calibración actualizada:', this.calibration);
        
        // Re-aplicar posiciones a todos los tokens
        for (const [id, char] of Object.entries(this.characters)) {
            if (this.tokens[id]) {
                this.setTokenPosition(this.tokens[id], char.position);
            }
        }
    }
    
    // Calibración automática basada en 4 puntos de referencia
    calibrateFromPoints(cameraPoints, screenPoints) {
        // cameraPoints: [{x, y}, ...] - 4 esquinas detectadas por cámara
        // screenPoints: [{x, y}, ...] - 4 esquinas correspondientes en pantalla
        
        if (cameraPoints.length >= 2 && screenPoints.length >= 2) {
            // Calcular escala simple (usando primeros 2 puntos)
            const camDx = cameraPoints[1].x - cameraPoints[0].x;
            const camDy = cameraPoints[1].y - cameraPoints[0].y;
            const scrDx = screenPoints[1].x - screenPoints[0].x;
            const scrDy = screenPoints[1].y - screenPoints[0].y;
            
            const scaleX = scrDx / camDx;
            const scaleY = scrDy / camDy;
            
            // Calcular offset
            const offsetX = screenPoints[0].x - (cameraPoints[0].x * scaleX);
            const offsetY = screenPoints[0].y - (cameraPoints[0].y * scaleY);
            
            this.setCalibration(offsetX, offsetY, scaleX, scaleY);
        }
    }
    
    // Método para pantalla completa (importante para mesas táctiles)
    enterFullscreen() {
        const elem = document.documentElement;
        if (elem.requestFullscreen) {
            elem.requestFullscreen();
        } else if (elem.webkitRequestFullscreen) {
            elem.webkitRequestFullscreen();
        } else if (elem.msRequestFullscreen) {
            elem.msRequestFullscreen();
        }
    }
    
    exitFullscreen() {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
    
    // === Sistema de Miniaturas (desde cámara YOLO) ===
    
    updateMiniaturePositions(miniatures, assignments = null, characters = null) {
        /**
         * Actualiza las posiciones de las miniaturas detectadas por la cámara.
         * Cada miniatura tiene: id, center.x, center.y, orientation, confidence
         * Las coordenadas vienen normalizadas respecto al tamaño del frame de la cámara.
         * 
         * @param {Array} miniatures - Lista de miniaturas detectadas
         * @param {Object} assignments - Mapa de track_id -> character_id
         * @param {Object} characters - Mapa de character_id -> character data
         */
        
        if (!this.miniatureTokens) {
            this.miniatureTokens = {};
        }
        
        // Guardar asignaciones y personajes para uso interno
        if (assignments) {
            this.miniatureAssignments = assignments;
        }
        if (characters) {
            this.miniatureCharacters = characters;
        }
        
        const currentIds = new Set();
        
        miniatures.forEach(m => {
            const id = m.id || m.marker_id;
            currentIds.add(id);
            
            // Convertir coordenadas de cámara a coordenadas de pantalla
            const screenPos = this.cameraToScreen(m.center || m);
            
            // Obtener info del personaje asignado
            const characterId = this.miniatureAssignments?.[id];
            const character = characterId ? this.miniatureCharacters?.[characterId] : null;
            
            if (this.miniatureTokens[id]) {
                // Actualizar posición existente con animación suave
                this.updateMiniatureToken(id, screenPos, m.orientation, character);
            } else {
                // Crear nuevo token de miniatura
                this.createMiniatureToken(id, screenPos, m.orientation, character);
            }
        });
        
        // Eliminar tokens que ya no están visibles
        Object.keys(this.miniatureTokens).forEach(id => {
            if (!currentIds.has(parseInt(id)) && !currentIds.has(id)) {
                this.removeMiniatureToken(id);
            }
        });
    }
    
    cameraToScreen(pos) {
        /**
         * Convierte coordenadas de la cámara (píxeles del frame procesado por YOLO)
         * a coordenadas de pantalla, y aplica la calibración manual (offset/escala)
         * que el GM ajusta desde el panel de calibración.
         */
        const canvasWidth = this.mapCanvas.width;
        const canvasHeight = this.mapCanvas.height;

        // Resolución real del frame que procesó el servidor (enviada junto a cada
        // actualización de posiciones). Si aún no se conoce, se asume 1280x720
        // como valor de partida razonable hasta que llegue el primer frame.
        const cameraWidth = this.cameraFrameSize?.width || 1280;
        const cameraHeight = this.cameraFrameSize?.height || 720;

        const normalizedX = (pos.x / cameraWidth) * canvasWidth;
        const normalizedY = (pos.y / cameraHeight) * canvasHeight;

        return {
            x: (normalizedX * this.calibration.scaleX) + this.calibration.offsetX,
            y: (normalizedY * this.calibration.scaleY) + this.calibration.offsetY
        };
    }
    
    createMiniatureToken(id, pos, orientation = 0, character = null) {
        const token = document.createElement('div');
        token.className = 'miniature-token';
        if (character) token.classList.add('has-character');
        token.id = `miniature-${id}`;
        token.dataset.miniatureId = id;
        
        const hasCharacter = character !== null;
        const name = character?.character_name || character?.data?.name || character?.name || `#${id}`;
        const hp = character?.data?.hp || character?.hp;
        const maxHp = character?.data?.max_hp || character?.max_hp;
        const charClass = character?.data?.class || character?.class || '';
        const tokenVisual = this.resolveTokenImage(character?.token_visual);  // Imagen del token asignada por el admin
        
        // Calcular porcentaje de HP para la barra
        const hpPercent = (hp && maxHp) ? Math.round((hp / maxHp) * 100) : 100;
        const hpColor = hpPercent > 50 ? '#4ade80' : hpPercent > 25 ? '#fbbf24' : '#ef4444';
        
        // El token NO rota - solo la flecha de dirección rota
        token.style.cssText = `
            position: absolute;
            left: ${pos.x}px;
            top: ${pos.y}px;
            transform: translate(-50%, -50%);
            transition: left 0.1s ease-out, top 0.1s ease-out;
            pointer-events: none;
            z-index: 100;
        `;
        
        // Guardar orientación como data attribute para actualizar la flecha
        token.dataset.orientation = orientation;
        
        if (hasCharacter) {
            // Token completo con información del personaje
            const tokenInnerContent = tokenVisual 
                ? `<img src="${tokenVisual}" alt="${this.escapeHtml(name)}" class="mini-token-image" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                   <div class="mini-avatar fallback" style="display:none;">${name.charAt(0).toUpperCase()}</div>`
                : `<div class="mini-avatar">${name.charAt(0).toUpperCase()}</div>`;
            
            token.innerHTML = `
                <div class="mini-token-container">
                    <div class="mini-token-inner character-assigned">
                        ${tokenInnerContent}
                    </div>
                    <div class="mini-direction-arrow" style="transform: translateX(-50%) rotate(${orientation - 90}deg);"></div>
                    <div class="mini-info-panel">
                        <div class="mini-name">${this.escapeHtml(name)}</div>
                        ${charClass ? `<div class="mini-class">${this.escapeHtml(charClass)}</div>` : ''}
                        ${hp !== undefined ? `
                            <div class="mini-hp-bar">
                                <div class="mini-hp-fill" style="width: ${hpPercent}%; background: ${hpColor};"></div>
                                <span class="mini-hp-text">${hp}/${maxHp || '?'}</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `;
        } else {
            // Token simple sin asignar
            token.innerHTML = `
                <div class="mini-token-container">
                    <div class="mini-token-inner unassigned">
                        <span class="mini-id-label">#${id}</span>
                    </div>
                    <div class="mini-direction-arrow" style="transform: translateX(-50%) rotate(${orientation - 90}deg);"></div>
                </div>
            `;
        }
        
        this.tokensContainer.appendChild(token);
        this.miniatureTokens[id] = { element: token, character, orientation };
        
        // Animación de entrada
        token.style.animation = 'tokenAppear 0.3s ease-out';
        
        console.log(`🎯 Miniatura #${id} creada en (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})${hasCharacter ? ` → ${name}${character?.token_visual ? ' (con imagen)' : ''}` : ''}`);
    }
    
    updateMiniatureToken(id, pos, orientation = 0, character = null) {
        const tokenData = this.miniatureTokens[id];
        if (!tokenData) return;
        
        const token = tokenData.element || tokenData;
        
        // Actualizar posición (sin rotar todo el token)
        token.style.left = `${pos.x}px`;
        token.style.top = `${pos.y}px`;
        
        // Actualizar solo la flecha de orientación
        const arrow = token.querySelector('.mini-direction-arrow');
        if (arrow) {
            arrow.style.transform = `translateX(-50%) rotate(${orientation - 90}deg)`;
        }
        token.dataset.orientation = orientation;
        
        // Si el personaje cambió, recrear el token
        const currentCharId = tokenData.character?.id;
        const newCharId = character?.id;
        if (currentCharId !== newCharId) {
            this.removeMiniatureToken(id);
            this.createMiniatureToken(id, pos, orientation, character);
        }
    }
    
    removeMiniatureToken(id) {
        const tokenData = this.miniatureTokens[id];
        if (tokenData) {
            const token = tokenData.element || tokenData;
            token.style.animation = 'tokenDisappear 0.3s ease-out';
            setTimeout(() => {
                token.remove();
            }, 300);
            delete this.miniatureTokens[id];
            console.log(`👋 Miniatura #${id} eliminada`);
        }
    }
    
    // Actualizar asignaciones (llamado cuando cambian)
    updateMiniatureAssignments(assignments, characters) {
        console.log('🔄 Actualizando asignaciones:', assignments, 'Personajes:', Object.keys(characters || {}));
        
        this.miniatureAssignments = assignments || {};
        this.miniatureCharacters = characters || {};
        
        // Recrear todos los tokens con la nueva info
        if (this.miniatureTokens && Object.keys(this.miniatureTokens).length > 0) {
            Object.keys(this.miniatureTokens).forEach(id => {
                const tokenData = this.miniatureTokens[id];
                const token = tokenData?.element || tokenData;
                if (!token || !token.style) return;
                
                const pos = {
                    x: parseFloat(token.style.left) || 0,
                    y: parseFloat(token.style.top) || 0
                };
                const orientationMatch = token.style.transform?.match(/rotate\(([^)]+)deg\)/);
                const orientation = parseFloat(orientationMatch?.[1] || 0);
                
                // Buscar por id numérico o string
                const characterId = assignments?.[id] || assignments?.[parseInt(id)];
                const character = characterId ? (characters?.[characterId] || null) : null;
                
                console.log(`  Token #${id}: characterId=${characterId}, character=${character?.character_name || character?.name || 'null'}`);
                
                this.removeMiniatureToken(id);
                this.createMiniatureToken(parseInt(id), pos, orientation, character);
            });
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }
    
    toggleFullscreen() {
        if (document.fullscreenElement) {
            this.exitFullscreen();
        } else {
            this.enterFullscreen();
        }
    }
}


// Instancia global
window.gameRenderer = new GameRenderer();

// Atajos globales
window.addEventListener('keydown', (e) => {
    // F11 o F para fullscreen
    if (e.key === 'F11' || (e.key === 'f' && !e.ctrlKey)) {
        e.preventDefault();
        window.gameRenderer.toggleFullscreen();
    }
    // G para toggle grid
    if (e.key === 'g') {
        window.gameRenderer.showGrid = !window.gameRenderer.showGrid;
        window.gameRenderer.redraw();
    }
});
