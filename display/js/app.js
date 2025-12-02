/**
 * MesaRPG - Aplicación Principal del Display
 * Coordina WebSocket, Renderer y Effects
 */

class MesaRPGApp {
    constructor() {
        this.state = {
            characters: {},
            players: {},
            is_combat: false,
            current_turn: 0,
            active_character_id: null,
            current_map: 'default'
        };
        
        this.init();
    }
    
    init() {
        console.log('🎲 MesaRPG Display inicializando...');
        
        // Iniciar sistemas
        window.effectsManager.start();
        window.gameRenderer.loadMap('default');
        
        // Configurar eventos WebSocket
        this.setupWebSocketEvents();
        
        // Conectar
        window.wsManager.connect();
        
        // Eventos de teclado
        this.setupKeyboardEvents();
        
        console.log('✅ MesaRPG Display listo');
    }
    
    setupWebSocketEvents() {
        const ws = window.wsManager;
        
        // Estado completo
        ws.on('state_update', (payload) => {
            this.updateFullState(payload);
        });
        
        ws.on('STATE_UPDATE', (payload) => {
            this.updateFullState(payload);
        });
        
        // Personajes
        ws.on('character_added', (payload) => {
            if (payload.character) {
                this.state.characters[payload.character.id] = payload.character;
                window.gameRenderer.updateCharacters(this.state.characters);
                window.gameRenderer.addLogEntry(
                    `${payload.character.name} ha entrado en escena`,
                    'system'
                );
            }
        });
        
        ws.on('character_removed', (payload) => {
            if (payload.character_id) {
                delete this.state.characters[payload.character_id];
                window.gameRenderer.updateCharacters(this.state.characters);
                window.gameRenderer.addLogEntry(
                    `${payload.name || 'Un personaje'} ha salido de escena`,
                    'system'
                );
            }
        });
        
        ws.on('character_update', (payload) => {
            if (payload.character_id && payload.position) {
                const char = this.state.characters[payload.character_id];
                if (char) {
                    char.position = payload.position;
                    window.gameRenderer.updateCharacters(this.state.characters);
                }
            }
        });
        
        // Combate
        ws.on('combat_start', (payload) => {
            this.state.is_combat = true;
            this.state.current_turn = payload.turn || 1;
            this.state.initiative_order = payload.initiative_order || [];
            this.state.active_character_id = payload.active_character;
            
            window.gameRenderer.updateCombatPanel(this.state);
            window.gameRenderer.addLogEntry('⚔️ ¡El combate ha comenzado!', 'combat');
            
            // Efecto de inicio de combate
            window.effectsManager.playSound('combat_start');
        });
        
        ws.on('combat_end', () => {
            this.state.is_combat = false;
            this.state.initiative_order = [];
            this.state.active_character_id = null;
            
            window.gameRenderer.updateCombatPanel(this.state);
            window.gameRenderer.addLogEntry('🕊️ El combate ha terminado', 'combat');
        });
        
        ws.on('turn_change', (payload) => {
            this.state.current_turn = payload.turn;
            this.state.active_character_id = payload.active_character;
            
            const char = this.state.characters[payload.active_character];
            if (char) {
                window.gameRenderer.addLogEntry(
                    `Turno de ${char.name}`,
                    'turn'
                );
            }
            
            window.gameRenderer.updateCombatPanel(this.state);
        });
        
        // Acciones y efectos
        ws.on('action_executed', (payload) => {
            const result = payload.result;
            
            // Log de acción
            if (result && result.message) {
                let logType = 'ability';
                if (result.damage_dealt > 0) logType = 'damage';
                if (result.healing_done > 0) logType = 'heal';
                
                window.gameRenderer.addLogEntry(result.message, logType);
            }
            
            // Actualizar personajes afectados
            // (El estado actualizado vendrá en otro mensaje)
        });
        
        ws.on('effect', (payload) => {
            this.playEffect(payload);
        });
        
        ws.on('EFFECT', (payload) => {
            this.playEffect(payload);
        });
        
        // Jugadores
        ws.on('player_joined', (payload) => {
            if (payload.player) {
                this.state.players[payload.player.id] = payload.player;
                window.gameRenderer.addLogEntry(
                    `${payload.player.name} se ha unido`,
                    'system'
                );
            }
        });
        
        ws.on('player_left', (payload) => {
            if (payload.player_id) {
                const player = this.state.players[payload.player_id];
                delete this.state.players[payload.player_id];
                window.gameRenderer.addLogEntry(
                    `${payload.name || player?.name || 'Un jugador'} se ha desconectado`,
                    'system'
                );
            }
        });
        
        // Conexión
        ws.on('connected', () => {
            window.gameRenderer.addLogEntry('Conectado al servidor', 'system');
        });
        
        ws.on('disconnected', () => {
            window.gameRenderer.addLogEntry('Desconectado del servidor', 'system');
        });
    }
    
    updateFullState(state) {
        console.log('📊 Actualizando estado completo:', state);
        
        this.state = {
            ...this.state,
            ...state
        };
        
        // Actualizar renderer
        if (state.characters) {
            window.gameRenderer.updateCharacters(state.characters);
        }
        
        // Actualizar panel de combate
        window.gameRenderer.updateCombatPanel(this.state);
        
        // Cargar mapa si cambió
        if (state.current_map && state.current_map !== this.state.current_map) {
            window.gameRenderer.loadMap(state.current_map);
        }
    }
    
    playEffect(effectData) {
        if (!effectData) return;
        
        // Reproducir efecto visual
        window.effectsManager.playEffect(effectData);
        
        // Mostrar números de daño/curación
        if (effectData.damage > 0 && effectData.target_position) {
            window.effectsManager.showDamage(
                effectData.target_position.x,
                effectData.target_position.y,
                effectData.damage,
                effectData.is_critical
            );
        }
        
        if (effectData.heal > 0 && effectData.target_position) {
            window.effectsManager.showHeal(
                effectData.target_position.x,
                effectData.target_position.y,
                effectData.heal
            );
        }
    }
    
    setupKeyboardEvents() {
        document.addEventListener('keydown', (e) => {
            switch (e.key) {
                case 'F11':
                    // Toggle fullscreen
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    } else {
                        document.documentElement.requestFullscreen();
                    }
                    break;
                    
                case 'g':
                    // Toggle grid
                    window.gameRenderer.showGrid = !window.gameRenderer.showGrid;
                    window.gameRenderer.redraw();
                    break;
                    
                case 'Escape':
                    // Deseleccionar
                    window.gameRenderer.selectCharacter(null);
                    break;
            }
        });
    }
}


// Iniciar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    window.app = new MesaRPGApp();
});
