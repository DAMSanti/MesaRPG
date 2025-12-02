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
        
        this.gridSize = 50; // Tamaño de celda en píxeles
        this.showGrid = true;
        
        // Estado de arrastre
        this.dragging = null; // { tokenId, offsetX, offsetY }
        this.longPressTimer = null;
        this.longPressPos = null;
        
        // Contador para IDs únicos de tokens locales
        this.localTokenCounter = 0;
        
        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        // Inicializar eventos táctiles
        this.setupTouchEvents();
    }
    
    setupTouchEvents() {
        console.log('🖐️ Configurando eventos táctiles en:', this.tokensContainer);
        
        // Eventos táctiles en el contenedor
        this.tokensContainer.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
        this.tokensContainer.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        this.tokensContainer.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
        this.tokensContainer.addEventListener('touchcancel', (e) => this.handleTouchEnd(e), { passive: false });
        
        // Eventos de mouse para desarrollo/debug
        this.tokensContainer.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.tokensContainer.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.tokensContainer.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        this.tokensContainer.addEventListener('mouseleave', (e) => this.handleMouseUp(e));
        
        // Click simple para crear token (más fácil para testing)
        this.tokensContainer.addEventListener('click', (e) => {
            // Solo crear si no hay tokens en ese punto
            const tokenEl = e.target.closest('.character-token');
            if (!tokenEl) {
                console.log('👆 Click en posición:', e.clientX, e.clientY);
                this.createLocalToken(e.clientX, e.clientY);
            }
        });
        
        console.log('✅ Eventos táctiles configurados');
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
        this.createToken(localId, char);
        
        console.log('✨ Token local creado:', char.name, 'en', x, y);
        
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
    
    redraw() {
        const ctx = this.mapCtx;
        const w = this.mapCanvas.width;
        const h = this.mapCanvas.height;
        
        // Limpiar
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, w, h);
        
        // Dibujar imagen del mapa si existe
        if (this.mapImage) {
            ctx.drawImage(this.mapImage, 0, 0, w, h);
        } else {
            // Fondo por defecto con patrón
            this.drawDefaultBackground(ctx, w, h);
        }
        
        // Dibujar grid si está activo
        if (this.showGrid) {
            this.drawGrid(ctx, w, h);
        }
    }
    
    drawDefaultBackground(ctx, w, h) {
        // Gradiente de fondo
        const gradient = ctx.createRadialGradient(w/2, h/2, 0, w/2, h/2, Math.max(w, h)/2);
        gradient.addColorStop(0, '#2a2a4a');
        gradient.addColorStop(1, '#1a1a2e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
        
        // Patrón de piedra/mazmorra
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.lineWidth = 1;
        
        for (let x = 0; x < w; x += this.gridSize * 2) {
            for (let y = 0; y < h; y += this.gridSize * 2) {
                ctx.strokeRect(x, y, this.gridSize * 2, this.gridSize * 2);
            }
        }
    }
    
    drawGrid(ctx, w, h) {
        // Cuadrícula hexagonal del tamaño de un token (100px)
        const hexSize = 50; // Radio del hexágono (mitad del token)
        const hexWidth = hexSize * 2;
        const hexHeight = Math.sqrt(3) * hexSize;
        const vertDist = hexHeight;
        const horizDist = hexSize * 1.5;
        
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.15)'; // Dorado sutil
        ctx.lineWidth = 1;
        
        let row = 0;
        for (let y = 0; y < h + hexHeight; y += vertDist) {
            const offsetX = (row % 2) * horizDist;
            for (let x = -hexSize + offsetX; x < w + hexWidth; x += horizDist * 2) {
                this.drawHexagon(ctx, x, y, hexSize);
            }
            row++;
        }
    }
    
    drawHexagon(ctx, centerX, centerY, size) {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            // Hexágono con punta arriba (flat-top)
            const angle = (Math.PI / 3) * i - Math.PI / 6;
            const x = centerX + size * Math.cos(angle);
            const y = centerY + size * Math.sin(angle);
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.closePath();
        ctx.stroke();
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
    
    createToken(id, char) {
        console.log('🎭 Creando token:', char.name);
        
        const token = document.createElement('div');
        token.className = 'character-token';
        token.id = `token-${id}`;
        token.dataset.characterId = id;
        
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
        
        // Eventos táctiles y click
        token.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectCharacter(id);
        });
        token.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            this.selectCharacter(id);
        }, { passive: true });
        
        // Posición inicial - aplicar calibración
        this.setTokenPosition(token, char.position);
        
        this.tokensContainer.appendChild(token);
        this.tokens[id] = token;
        
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
