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
                case 'f':
                    // Toggle fullscreen
                    e.preventDefault();
                    window.gameRenderer.toggleFullscreen();
                    break;
                    
                case 'g':
                    // Toggle grid
                    window.gameRenderer.showGrid = !window.gameRenderer.showGrid;
                    window.gameRenderer.redraw();
                    break;
                    
                case 'Escape':
                    // Cerrar modal o deseleccionar
                    const modal = document.getElementById('calibration-modal');
                    if (!modal.classList.contains('hidden')) {
                        modal.classList.add('hidden');
                    } else {
                        window.gameRenderer.selectCharacter(null);
                    }
                    break;
            }
        });
    }
    
    setupDisplayControls() {
        // Botón de pantalla completa
        const btnFullscreen = document.getElementById('btn-fullscreen');
        if (btnFullscreen) {
            btnFullscreen.addEventListener('click', () => {
                window.gameRenderer.toggleFullscreen();
            });
        }
        
        // Botón de calibración
        const btnCalibrate = document.getElementById('btn-calibrate');
        const modal = document.getElementById('calibration-modal');
        
        if (btnCalibrate && modal) {
            btnCalibrate.addEventListener('click', () => {
                this.openCalibrationModal();
            });
        }
        
        // Controles del modal de calibración
        this.setupCalibrationControls();
    }
    
    openCalibrationModal() {
        const modal = document.getElementById('calibration-modal');
        modal.classList.remove('hidden');
        
        // Cargar valores actuales
        const cal = window.gameRenderer.calibration;
        document.getElementById('cal-offset-x').value = cal.offsetX;
        document.getElementById('cal-offset-y').value = cal.offsetY;
        document.getElementById('cal-scale-x').value = cal.scaleX;
        document.getElementById('cal-scale-y').value = cal.scaleY;
        
        this.updateCalibrationLabels();
    }
    
    setupCalibrationControls() {
        const controls = ['offset-x', 'offset-y', 'scale-x', 'scale-y'];
        
        controls.forEach(id => {
            const input = document.getElementById(`cal-${id}`);
            if (input) {
                input.addEventListener('input', () => {
                    this.updateCalibrationLabels();
                    this.applyCalibration();
                });
            }
        });
        
        // Botones
        const btnSave = document.getElementById('btn-cal-save');
        const btnReset = document.getElementById('btn-cal-reset');
        const btnClose = document.getElementById('btn-cal-close');
        
        if (btnSave) {
            btnSave.addEventListener('click', () => {
                this.saveCalibration();
                document.getElementById('calibration-modal').classList.add('hidden');
            });
        }
        
        if (btnReset) {
            btnReset.addEventListener('click', () => {
                document.getElementById('cal-offset-x').value = 0;
                document.getElementById('cal-offset-y').value = 0;
                document.getElementById('cal-scale-x').value = 1;
                document.getElementById('cal-scale-y').value = 1;
                this.updateCalibrationLabels();
                this.applyCalibration();
            });
        }
        
        if (btnClose) {
            btnClose.addEventListener('click', () => {
                document.getElementById('calibration-modal').classList.add('hidden');
            });
        }
    }
    
    updateCalibrationLabels() {
        document.getElementById('val-offset-x').textContent = document.getElementById('cal-offset-x').value;
        document.getElementById('val-offset-y').textContent = document.getElementById('cal-offset-y').value;
        document.getElementById('val-scale-x').textContent = parseFloat(document.getElementById('cal-scale-x').value).toFixed(1);
        document.getElementById('val-scale-y').textContent = parseFloat(document.getElementById('cal-scale-y').value).toFixed(1);
    }
    
    applyCalibration() {
        const offsetX = parseFloat(document.getElementById('cal-offset-x').value);
        const offsetY = parseFloat(document.getElementById('cal-offset-y').value);
        const scaleX = parseFloat(document.getElementById('cal-scale-x').value);
        const scaleY = parseFloat(document.getElementById('cal-scale-y').value);
        
        window.gameRenderer.setCalibration(offsetX, offsetY, scaleX, scaleY);
    }
    
    saveCalibration() {
        const calibration = {
            offsetX: parseFloat(document.getElementById('cal-offset-x').value),
            offsetY: parseFloat(document.getElementById('cal-offset-y').value),
            scaleX: parseFloat(document.getElementById('cal-scale-x').value),
            scaleY: parseFloat(document.getElementById('cal-scale-y').value)
        };
        
        localStorage.setItem('mesarpg_calibration', JSON.stringify(calibration));
        console.log('✅ Calibración guardada:', calibration);
    }
    
    loadCalibration() {
        try {
            const saved = localStorage.getItem('mesarpg_calibration');
            if (saved) {
                const cal = JSON.parse(saved);
                window.gameRenderer.setCalibration(cal.offsetX, cal.offsetY, cal.scaleX, cal.scaleY);
                console.log('📐 Calibración cargada:', cal);
            }
        } catch (e) {
            console.warn('No se pudo cargar la calibración guardada:', e);
        }
    }
}


// Iniciar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    window.app = new MesaRPGApp();
    window.app.setupDisplayControls();
    window.app.loadCalibration();
});
