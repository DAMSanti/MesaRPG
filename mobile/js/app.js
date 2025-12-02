/**
 * MesaRPG - App Móvil Principal
 * Maneja conexión WebSocket y estado de la aplicación
 */

class MobileApp {
    constructor() {
        this.playerId = null;
        this.playerName = '';
        this.selectedCharacterId = null;
        this.myCharacter = null;
        this.gameState = {
            characters: {},
            is_combat: false,
            active_character_id: null
        };
        
        this.ws = null;
        // Detectar automáticamente el protocolo correcto (ws para http, wss para https)
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.serverUrl = `${wsProtocol}//${window.location.host}/ws/mobile`;
        
        this.init();
    }
    
    init() {
        console.log('📱 MesaRPG Mobile iniciando...');
        
        // Eventos de UI
        this.setupLoginEvents();
        
        // Recuperar nombre guardado
        const savedName = localStorage.getItem('mesarpg_name');
        if (savedName) {
            document.getElementById('player-name').value = savedName;
        }
    }
    
    setupLoginEvents() {
        const loginForm = document.getElementById('login-form');
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.login();
        });
    }
    
    login() {
        const nameInput = document.getElementById('player-name');
        this.playerName = nameInput.value.trim();
        
        if (!this.playerName) {
            this.showToast('Introduce tu nombre', 'error');
            return;
        }
        
        // Guardar nombre
        localStorage.setItem('mesarpg_name', this.playerName);
        
        // Generar ID único
        this.playerId = 'player_' + Math.random().toString(36).substr(2, 9);
        
        // Conectar al servidor
        this.connect();
    }
    
    connect() {
        const url = `${this.serverUrl}?player_id=${this.playerId}&name=${encodeURIComponent(this.playerName)}`;
        
        console.log('🔌 Conectando a:', url);
        this.ws = new WebSocket(url);
        
        this.ws.onopen = () => {
            console.log('✅ Conectado');
            document.getElementById('connection-error').classList.add('hidden');
            this.showScreen('select-screen');
            document.getElementById('player-display-name').textContent = this.playerName;
        };
        
        this.ws.onclose = () => {
            console.log('❌ Desconectado');
            this.showToast('Conexión perdida', 'error');
            // Intentar reconectar después de 3 segundos
            setTimeout(() => {
                if (this.playerId) {
                    this.connect();
                }
            }, 3000);
        };
        
        this.ws.onerror = (error) => {
            console.error('Error WS:', error);
            document.getElementById('connection-error').classList.remove('hidden');
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleMessage(data);
            } catch (e) {
                console.error('Error parseando mensaje:', e);
            }
        };
    }
    
    handleMessage(data) {
        const type = data.type;
        const payload = data.payload || {};
        
        console.log('📨 Mensaje:', type, payload);
        
        switch (type) {
            case 'connected':
                if (payload.state) {
                    this.updateGameState(payload.state);
                }
                break;
                
            case 'state_update':
            case 'STATE_UPDATE':
                this.updateGameState(payload);
                break;
                
            case 'character_added':
                if (payload.character) {
                    this.gameState.characters[payload.character.id] = payload.character;
                    this.updateCharacterList();
                    this.showToast(`${payload.character.name} detectado`);
                }
                break;
                
            case 'character_removed':
                if (payload.character_id) {
                    delete this.gameState.characters[payload.character_id];
                    this.updateCharacterList();
                    
                    // Si era mi personaje
                    if (payload.character_id === this.selectedCharacterId) {
                        this.selectedCharacterId = null;
                        this.myCharacter = null;
                        this.showScreen('select-screen');
                        this.showToast('Tu figurita fue removida', 'error');
                    }
                }
                break;
                
            case 'character_selected':
                if (payload.success) {
                    this.onCharacterSelected();
                } else {
                    this.showToast('No se pudo seleccionar el personaje', 'error');
                }
                break;
                
            case 'ability_result':
                this.handleAbilityResult(payload);
                break;
                
            case 'turn_change':
                this.gameState.active_character_id = payload.active_character;
                this.updateTurnStatus();
                break;
                
            case 'combat_start':
                this.gameState.is_combat = true;
                this.gameState.active_character_id = payload.active_character;
                this.updateTurnStatus();
                this.showToast('⚔️ ¡Combate iniciado!');
                break;
                
            case 'combat_end':
                this.gameState.is_combat = false;
                this.gameState.active_character_id = null;
                this.updateTurnStatus();
                this.showToast('🕊️ Combate finalizado');
                break;
                
            case 'action_executed':
                if (payload.result) {
                    this.addLogEntry(payload.result.message);
                }
                // Actualizar estado de mi personaje
                if (this.myCharacter && payload.action) {
                    // Recargar abilities para actualizar cooldowns
                    this.loadAbilities();
                }
                break;
                
            case 'error':
                this.showToast(payload.message || 'Error', 'error');
                break;
        }
    }
    
    updateGameState(state) {
        if (state.characters) {
            this.gameState.characters = state.characters;
            this.updateCharacterList();
            
            // Actualizar mi personaje si está seleccionado
            if (this.selectedCharacterId && state.characters[this.selectedCharacterId]) {
                this.myCharacter = state.characters[this.selectedCharacterId];
                this.updateControlPanel();
            }
        }
        
        if (state.is_combat !== undefined) {
            this.gameState.is_combat = state.is_combat;
        }
        
        if (state.active_character_id !== undefined) {
            this.gameState.active_character_id = state.active_character_id;
        }
        
        this.updateTurnStatus();
    }
    
    updateCharacterList() {
        const listEl = document.getElementById('character-list');
        const characters = Object.values(this.gameState.characters);
        
        if (characters.length === 0) {
            listEl.innerHTML = '<p class="empty-message">Esperando personajes...<br>Coloca figuritas en la mesa</p>';
            document.getElementById('waiting-message').classList.remove('hidden');
            return;
        }
        
        document.getElementById('waiting-message').classList.add('hidden');
        
        listEl.innerHTML = characters.map(char => {
            const isUnavailable = char.owner_id && char.owner_id !== this.playerId;
            const isSelected = char.id === this.selectedCharacterId;
            
            return `
                <div class="character-card ${isUnavailable ? 'unavailable' : ''} ${isSelected ? 'selected' : ''}"
                     data-character-id="${char.id}"
                     onclick="app.selectCharacter('${char.id}')">
                    <div class="avatar">${char.name.charAt(0)}</div>
                    <div class="name">${char.name}</div>
                    <div class="class">${char.character_class || char.class}</div>
                    ${isUnavailable ? '<div class="class" style="color: var(--color-warning);">En uso</div>' : ''}
                </div>
            `;
        }).join('');
    }
    
    selectCharacter(characterId) {
        const char = this.gameState.characters[characterId];
        if (!char) return;
        
        if (char.owner_id && char.owner_id !== this.playerId) {
            this.showToast('Este personaje ya está en uso', 'error');
            return;
        }
        
        this.selectedCharacterId = characterId;
        this.send('select_character', { character_id: characterId });
    }
    
    onCharacterSelected() {
        this.myCharacter = this.gameState.characters[this.selectedCharacterId];
        if (!this.myCharacter) return;
        
        this.showScreen('control-screen');
        this.updateControlPanel();
        this.loadAbilities();
        this.setupControlEvents();
        
        this.showToast(`¡${this.myCharacter.name} seleccionado!`, 'success');
    }
    
    updateControlPanel() {
        if (!this.myCharacter) return;
        
        const char = this.myCharacter;
        
        // Avatar y nombre
        document.getElementById('control-avatar').textContent = char.name.charAt(0);
        document.getElementById('control-char-name').textContent = char.name;
        document.getElementById('control-char-class').textContent = char.character_class || char.class;
        
        // HP
        const hpPercent = (char.hp / char.max_hp) * 100;
        document.getElementById('control-hp-bar').style.width = `${hpPercent}%`;
        document.getElementById('control-hp-text').textContent = `${char.hp}/${char.max_hp}`;
        
        // Mana
        const manaPercent = (char.mana / char.max_mana) * 100;
        document.getElementById('control-mana-bar').style.width = `${manaPercent}%`;
        document.getElementById('control-mana-text').textContent = `${char.mana}/${char.max_mana}`;
    }
    
    updateTurnStatus() {
        const turnStatus = document.getElementById('turn-status');
        
        if (this.gameState.is_combat && 
            this.gameState.active_character_id === this.selectedCharacterId) {
            turnStatus.classList.remove('hidden');
            // Vibrar si es posible
            if (navigator.vibrate) {
                navigator.vibrate([100, 50, 100]);
            }
        } else {
            turnStatus.classList.add('hidden');
        }
    }
    
    async loadAbilities() {
        if (!this.selectedCharacterId) return;
        
        try {
            const response = await fetch(`/api/characters/${this.selectedCharacterId}/abilities`);
            const abilities = await response.json();
            this.renderAbilities(abilities);
        } catch (e) {
            console.error('Error cargando habilidades:', e);
        }
    }
    
    renderAbilities(abilities) {
        const listEl = document.getElementById('abilities-list');
        
        if (!abilities || abilities.length === 0) {
            listEl.innerHTML = '<p class="empty-message">Sin habilidades disponibles</p>';
            return;
        }
        
        listEl.innerHTML = abilities.map(ability => {
            const onCooldown = ability.cooldown_left > 0;
            
            return `
                <button class="ability-btn ${onCooldown ? 'on-cooldown' : ''}"
                        ${!ability.can_use ? 'disabled' : ''}
                        data-ability-id="${ability.id}"
                        data-cooldown="${ability.cooldown_left}"
                        onclick="app.useAbility('${ability.id}')">
                    <div class="ability-name">
                        ${this.getAbilityIcon(ability.effect_type)} ${ability.name}
                    </div>
                    <div class="ability-info">
                        ${ability.damage > 0 ? `<span class="damage">⚔️${ability.damage}</span>` : ''}
                        ${ability.heal > 0 ? `<span class="heal">❤️${ability.heal}</span>` : ''}
                        ${ability.mana_cost > 0 ? `<span class="mana">💧${ability.mana_cost}</span>` : ''}
                    </div>
                </button>
            `;
        }).join('');
    }
    
    getAbilityIcon(effectType) {
        const icons = {
            'fire': '🔥',
            'ice': '❄️',
            'lightning': '⚡',
            'heal': '💚',
            'shield': '🛡️',
            'poison': '☠️',
            'attack': '⚔️'
        };
        return icons[effectType] || '✨';
    }
    
    useAbility(abilityId) {
        // TODO: Mostrar modal de selección de objetivo si es necesario
        this.showTargetModal(abilityId);
    }
    
    showTargetModal(abilityId) {
        const modal = document.getElementById('target-modal');
        const targetList = document.getElementById('target-list');
        
        // Obtener posibles objetivos (otros personajes)
        const targets = Object.values(this.gameState.characters).filter(
            char => char.id !== this.selectedCharacterId && char.hp > 0
        );
        
        if (targets.length === 0) {
            // Sin objetivos, usar sin objetivo o a uno mismo
            this.executeAbility(abilityId, null);
            return;
        }
        
        targetList.innerHTML = targets.map(char => `
            <div class="target-item" onclick="app.executeAbility('${abilityId}', '${char.id}')">
                <div class="target-avatar">${char.name.charAt(0)}</div>
                <div class="target-info">
                    <div class="target-name">${char.name}</div>
                    <div class="target-hp">${char.hp}/${char.max_hp} HP</div>
                </div>
            </div>
        `).join('');
        
        // Opción de usarse a sí mismo (para curaciones)
        targetList.innerHTML += `
            <div class="target-item" onclick="app.executeAbility('${abilityId}', '${this.selectedCharacterId}')">
                <div class="target-avatar">🎯</div>
                <div class="target-info">
                    <div class="target-name">${this.myCharacter.name} (yo)</div>
                    <div class="target-hp">${this.myCharacter.hp}/${this.myCharacter.max_hp} HP</div>
                </div>
            </div>
        `;
        
        modal.classList.remove('hidden');
    }
    
    hideTargetModal() {
        document.getElementById('target-modal').classList.add('hidden');
    }
    
    executeAbility(abilityId, targetId) {
        this.hideTargetModal();
        
        this.send('ability', {
            character_id: this.selectedCharacterId,
            ability_id: abilityId,
            target_id: targetId
        });
    }
    
    handleAbilityResult(result) {
        if (result.success) {
            this.showToast(result.message, 'success');
            
            // Recargar habilidades para actualizar cooldowns
            setTimeout(() => this.loadAbilities(), 500);
        } else {
            this.showToast(result.message, 'error');
        }
    }
    
    setupControlEvents() {
        // Botón salir
        document.getElementById('btn-leave').onclick = () => {
            this.selectedCharacterId = null;
            this.myCharacter = null;
            this.showScreen('select-screen');
        };
        
        // Cancelar selección de objetivo
        document.getElementById('btn-cancel-target').onclick = () => {
            this.hideTargetModal();
        };
        
        // Acciones rápidas
        document.getElementById('btn-attack').onclick = () => {
            // Buscar habilidad de ataque básico
            this.useAbility('basic_attack');
        };
        
        document.getElementById('btn-defend').onclick = () => {
            this.useAbility('defend');
        };
        
        document.getElementById('btn-end-turn').onclick = () => {
            this.send('end_turn', { character_id: this.selectedCharacterId });
            this.showToast('Turno finalizado');
        };
    }
    
    // === Utilidades ===
    
    send(type, payload = {}) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, payload }));
        }
    }
    
    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(screenId).classList.add('active');
    }
    
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        
        setTimeout(() => toast.remove(), 3000);
    }
    
    addLogEntry(message) {
        const log = document.getElementById('mobile-log');
        const entry = document.createElement('div');
        entry.className = 'log-entry-mini';
        entry.textContent = message;
        log.insertBefore(entry, log.firstChild);
        
        // Limitar entradas
        while (log.children.length > 10) {
            log.removeChild(log.lastChild);
        }
    }
}

// Iniciar app
const app = new MobileApp();
