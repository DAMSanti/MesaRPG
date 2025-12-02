/**
 * MesaRPG - Renderer de Mapa y Tokens
 * Dibuja el mapa, personajes y elementos del juego
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
        
        this.resize();
        window.addEventListener('resize', () => this.resize());
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
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        
        // Líneas verticales
        for (let x = 0; x <= w; x += this.gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        
        // Líneas horizontales
        for (let y = 0; y <= h; y += this.gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
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
        `;
        
        // Intentar cargar imagen
        const img = new Image();
        img.onload = () => {
            const inner = token.querySelector('.token-inner');
            inner.innerHTML = '';
            inner.appendChild(img);
        };
        img.src = `assets/tokens/${char.marker_id}.png`;
        
        // Eventos
        token.addEventListener('click', () => this.selectCharacter(id));
        
        // Posición inicial
        if (char.position) {
            token.style.left = `${char.position.x}px`;
            token.style.top = `${char.position.y}px`;
        } else {
            // Posición por defecto
            token.style.left = '100px';
            token.style.top = '100px';
        }
        
        this.tokensContainer.appendChild(token);
        this.tokens[id] = token;
    }
    
    updateToken(id, char) {
        const token = this.tokens[id];
        if (!token) return;
        
        // Actualizar posición con animación
        if (char.position) {
            token.style.left = `${char.position.x}px`;
            token.style.top = `${char.position.y}px`;
        }
        
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
}


// Instancia global
window.gameRenderer = new GameRenderer();
