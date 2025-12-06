/**
 * MesaRPG - Aplicación Principal del Display
 * Coordina WebSocket, Renderer y Effects
 */

class MesaRPGApp {
    constructor() {
        this.state = {
            characters: {},
            charactersById: {},  // Mapa id -> character para acceso rápido
            players: {},
            is_combat: false,
            current_turn: 0,
            active_character_id: null,
            current_map: 'default',
            miniatures: {},
            miniatureAssignments: {}  // track_id -> character_id
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
        
        // Cargar asignaciones
        this.loadMiniatureAssignments();
        
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
        
        // Mapa proyectado desde el admin
        ws.on('map_changed', (payload) => {
            console.log('🗺️ Mapa recibido desde admin:', payload);
            if (payload.map) {
                window.gameRenderer.loadMapData(payload.map);
                window.gameRenderer.addLogEntry('Mapa proyectado por el GM', 'system');
            }
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
        
        // Cambio de sistema de juego
        ws.on('game_system_changed', (payload) => {
            if (payload.system) {
                this.state.game_system = payload.system;
                this.applyGameSystemConfig(payload.system);
                window.gameRenderer.addLogEntry(
                    `Sistema de juego: ${payload.system.name || payload.system_id}`,
                    'system'
                );
            }
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
        
        // === Tracking de miniaturas por cámara ===
        ws.on('miniature_positions', (payload) => {
            this.handleMiniaturePositions(payload);
        });
        
        // Asignaciones de figuritas a personajes
        ws.on('miniature_assigned', (payload) => {
            this.handleMiniatureAssignment(payload);
        });
        
        ws.on('miniature_unassigned', (payload) => {
            this.handleMiniatureAssignment(payload);
        });
        
        ws.on('player_action', (payload) => {
            this.handlePlayerAction(payload);
        });
        
        // Errores del servidor
        ws.on('error', (payload) => {
            const errorMsg = payload?.message || payload?.error || 'Error desconocido';
            console.error('Server error:', errorMsg);
            window.gameRenderer.addLogEntry(`Error: ${errorMsg}`, 'system');
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
        
        // Guardar el mapa anterior antes de actualizar el estado
        const previousMap = this.state.current_map;
        
        this.state = {
            ...this.state,
            ...state
        };
        
        // Construir mapa de personajes por ID para acceso rápido
        if (state.characters) {
            this.state.charactersById = {};
            Object.entries(state.characters).forEach(([key, char]) => {
                const id = char.id || key;
                this.state.charactersById[id] = char;
            });
        }
        
        // Si hay fichas aprobadas (approved_sheets), también las añadimos
        if (state.approved_sheets) {
            state.approved_sheets.forEach(sheet => {
                const id = sheet.id;
                if (id) {
                    this.state.charactersById[id] = sheet;
                }
            });
        }
        
        // Actualizar renderer
        if (state.characters) {
            window.gameRenderer.updateCharacters(state.characters);
        }
        
        // Actualizar panel de combate
        window.gameRenderer.updateCombatPanel(this.state);
        
        // Cargar mapa si hay uno en el estado
        // Comparar con el mapa anterior (antes del merge) o si no había mapa cargado
        if (state.current_map) {
            const currentMapId = typeof state.current_map === 'object' ? state.current_map.id : state.current_map;
            const previousMapId = typeof previousMap === 'object' ? previousMap?.id : previousMap;
            
            if (currentMapId !== previousMapId || !window.gameRenderer.mapData) {
                console.log('🗺️ Cargando mapa desde estado inicial:', currentMapId);
                if (typeof state.current_map === 'object') {
                    // Es un objeto con datos completos del mapa
                    window.gameRenderer.loadMapData(state.current_map);
                } else {
                    // Es solo un ID de mapa
                    window.gameRenderer.loadMap(state.current_map);
                }
            }
        }
        
        // Aplicar configuración del sistema de juego si está presente
        if (state.game_system_info && Object.keys(state.game_system_info).length > 0) {
            this.applyGameSystemConfig(state.game_system_info);
        } else if (state.game_system) {
            this.applyGameSystemConfig(state.game_system);
        }
    }
    
    // Aplicar configuración del sistema de juego al renderer
    applyGameSystemConfig(system) {
        if (!system) return;
        
        console.log('🎮 Aplicando configuración de sistema:', system.name || system.id);
        
        // Configurar la grid según el sistema
        if (window.gameRenderer) {
            window.gameRenderer.setGameSystem(system);
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
        
        // Cargar valores actuales de calibración de cámara
        const cal = window.gameRenderer.calibration;
        document.getElementById('cal-offset-x').value = cal.offsetX;
        document.getElementById('cal-offset-y').value = cal.offsetY;
        document.getElementById('cal-scale-x').value = cal.scaleX;
        document.getElementById('cal-scale-y').value = cal.scaleY;
        
        // Cargar valores de pantalla
        const screenConfig = window.gameRenderer.screenConfig;
        document.getElementById('screen-diagonal').value = screenConfig.diagonalInches;
        document.getElementById('grid-target-size').value = screenConfig.targetGridInches;
        
        // Mostrar info de resolución
        const info = window.gameRenderer.getScreenInfo();
        document.getElementById('screen-resolution-info').innerHTML = 
            `Resolución: ${info.resolution} | PPI: ${info.pixelsPerInch} | Grid: ${info.gridSizePixels}px`;
        
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
        
        // Controles de pantalla
        const screenDiagonal = document.getElementById('screen-diagonal');
        const gridTargetSize = document.getElementById('grid-target-size');
        
        if (screenDiagonal) {
            screenDiagonal.addEventListener('change', () => {
                window.gameRenderer.setScreenSize(parseFloat(screenDiagonal.value));
                this.updateScreenInfo();
            });
        }
        
        if (gridTargetSize) {
            gridTargetSize.addEventListener('change', () => {
                window.gameRenderer.setGridTargetSize(parseFloat(gridTargetSize.value));
                this.updateScreenInfo();
            });
        }
        
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
    
    updateScreenInfo() {
        const info = window.gameRenderer.getScreenInfo();
        const infoEl = document.getElementById('screen-resolution-info');
        if (infoEl) {
            infoEl.innerHTML = `Resolución: ${info.resolution} | PPI: ${info.pixelsPerInch} | Grid: ${info.gridSizePixels}px`;
        }
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
    
    // === Tracking de Miniaturas ===
    
    handleMiniaturePositions(payload) {
        const miniatures = payload.miniatures || [];
        
        // Guardar posiciones de miniaturas en el estado
        this.state.miniatures = {};
        miniatures.forEach(m => {
            // Soportar ambos formatos: tracks YOLO (id, center) y sistema anterior (marker_id, x, y)
            const id = m.id || m.marker_id;
            const x = m.center?.x ?? m.x;
            const y = m.center?.y ?? m.y;
            const rotation = m.orientation ?? m.rotation ?? 0;
            
            this.state.miniatures[id] = {
                id: id,
                playerId: m.player_id,
                playerName: m.player_name,
                characterName: m.character_name,
                x: x,
                y: y,
                center: { x, y },
                rotation: rotation,
                orientation: rotation,
                isVisible: m.is_visible !== false
            };
        });
        
        // Actualizar visualización de miniaturas con asignaciones y personajes
        if (window.gameRenderer && window.gameRenderer.updateMiniaturePositions) {
            window.gameRenderer.updateMiniaturePositions(
                miniatures, 
                this.state.miniatureAssignments, 
                this.state.charactersById
            );
        }
    }
    
    // Cargar asignaciones de miniaturas desde el servidor
    async loadMiniatureAssignments() {
        try {
            const response = await fetch('/api/miniature-assignments');
            const data = await response.json();
            this.state.miniatureAssignments = data.assignments || {};
            console.log('📌 Asignaciones cargadas:', this.state.miniatureAssignments);
        } catch (error) {
            console.warn('No se pudieron cargar asignaciones:', error);
            this.state.miniatureAssignments = {};
        }
    }
    
    // Manejar actualizaciones de asignaciones via WebSocket
    handleMiniatureAssignment(payload) {
        this.state.miniatureAssignments = payload.assignments || {};
        
        // Notificar al renderer para actualizar tokens
        if (window.gameRenderer && window.gameRenderer.updateMiniatureAssignments) {
            window.gameRenderer.updateMiniatureAssignments(
                this.state.miniatureAssignments,
                this.state.charactersById
            );
        }
    }
    
    handlePlayerAction(payload) {
        const { player_id, player_name, position, action_type, effect } = payload;
        
        console.log(`🎭 Acción de ${player_name} (${action_type}) en (${position.x}, ${position.y})`);
        
        // Reproducir efecto en la posición del jugador
        if (effect && window.effectsManager) {
            // Añadir la posición al efecto
            const effectWithPos = {
                ...effect,
                position: position
            };
            window.effectsManager.playEffect(effectWithPos);
        }
        
        // Si hay un renderer con soporte de efectos en posición
        if (window.gameRenderer && window.gameRenderer.playEffectAtPosition) {
            window.gameRenderer.playEffectAtPosition(position.x, position.y, action_type);
        }
        
        // Log de la acción
        window.gameRenderer.addLogEntry(
            `${player_name} realiza: ${action_type}`,
            'ability'
        );
    }
    
    // Método para obtener la posición de un jugador por su ID
    getPlayerPosition(playerId) {
        if (!this.state.miniatures) return null;
        
        for (const miniature of Object.values(this.state.miniatures)) {
            if (miniature.playerId === playerId && miniature.isVisible) {
                return { x: miniature.x, y: miniature.y };
            }
        }
        return null;
    }
    
    // Método para obtener la miniatura de un jugador
    getPlayerMiniature(playerId) {
        if (!this.state.miniatures) return null;
        
        return Object.values(this.state.miniatures).find(m => m.playerId === playerId);
    }
}


// Iniciar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    window.app = new MesaRPGApp();
    window.app.setupDisplayControls();
    window.app.loadCalibration();
});
