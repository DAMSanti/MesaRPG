/**
 * MesaRPG - Gestión de Fichas de Personaje (Mobile)
 * Maneja la creación, edición y envío de fichas
 */

class SheetManager {
    constructor(app) {
        this.app = app;
        this.currentSystem = null;
        this.systemTemplate = [];
        this.mySheet = null;
        this.sheetId = null;
        this.cameraStream = null;
        
        this.init();
    }
    
    init() {
        // Esperar a que el DOM esté listo
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setupEventListeners());
        } else {
            this.setupEventListeners();
        }
    }
    
    setupEventListeners() {
        console.log('📋 SheetManager: Configurando event listeners...');
        
        // Botones de opciones de ficha
        const btnManual = document.getElementById('btn-create-manual');
        const btnScan = document.getElementById('btn-scan-sheet');
        const btnPdf = document.getElementById('btn-download-pdf');
        
        if (btnManual) {
            btnManual.addEventListener('click', (e) => {
                e.preventDefault();
                console.log('📝 Click en Rellenar Formulario');
                this.showFormScreen();
            });
        }
        
        if (btnScan) {
            btnScan.addEventListener('click', (e) => {
                e.preventDefault();
                console.log('📷 Click en Escanear Ficha');
                this.showScanScreen();
            });
        }
        
        if (btnPdf) {
            btnPdf.addEventListener('click', (e) => {
                console.log('📄 Click en Descargar PDF');
                this.downloadPDF(e);
            });
        }
        
        // Botones de estado de ficha
        document.getElementById('btn-edit-sheet')?.addEventListener('click', () => this.showFormScreen());
        document.getElementById('btn-submit-sheet')?.addEventListener('click', () => this.submitSheet());
        document.getElementById('btn-fix-sheet')?.addEventListener('click', () => this.showFormScreen());
        document.getElementById('btn-go-control')?.addEventListener('click', () => this.goToControl());
        
        // Formulario
        document.getElementById('btn-back-from-form')?.addEventListener('click', () => this.backToStatus());
        document.getElementById('btn-save-draft')?.addEventListener('click', () => this.saveDraft());
        document.getElementById('btn-form-save')?.addEventListener('click', () => this.saveDraft());
        
        const form = document.getElementById('character-sheet-form');
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitSheet();
            });
        }
        
        // Escaneo
        document.getElementById('btn-back-from-scan')?.addEventListener('click', () => this.closeScanScreen());
        document.getElementById('btn-capture')?.addEventListener('click', () => this.captureImage());
        document.getElementById('btn-retry-scan')?.addEventListener('click', () => this.retryScan());
        document.getElementById('btn-process-scan')?.addEventListener('click', () => this.processScannedImage());
        
        console.log('✅ SheetManager: Event listeners configurados');
    }
    
    // === Estado del Sistema de Juego ===
    
    setGameSystem(systemData) {
        this.currentSystem = systemData;
        this.systemTemplate = systemData.character_template || [];
        
        // Actualizar UI
        const badge = document.getElementById('sheet-game-system');
        if (badge) {
            badge.textContent = `${systemData.icon || '🎮'} ${systemData.name}`;
        }
        
        // Configurar enlace de PDF
        this.updatePDFLink();
    }
    
    updatePDFLink() {
        const link = document.getElementById('btn-download-pdf');
        if (!link) return;
        
        // URLs de PDFs oficiales externos (fichas reales)
        const pdfUrls = {
            'dnd5e': 'https://media.wizards.com/2022/dnd/downloads/DnD_5E_CharacterSheet_FormFillable.pdf',
            'battletech': 'https://bg.battletech.com/download/CAT35690_BattleMech%20Record%20Sheets.pdf',
            'generic': null
        };
        
        const systemId = this.currentSystem?.id || 'generic';
        const pdfUrl = pdfUrls[systemId];
        
        if (pdfUrl) {
            link.href = pdfUrl;
            link.target = '_blank';
            link.classList.remove('hidden');
        } else {
            link.classList.add('hidden');
        }
    }
    
    // === Actualizar Estado de Ficha ===
    
    updateSheetStatus(sheet) {
        this.mySheet = sheet;
        this.sheetId = sheet?.id;
        
        // Ocultar todos los paneles
        document.querySelectorAll('.status-panel').forEach(p => p.classList.add('hidden'));
        
        if (!sheet) {
            document.getElementById('no-sheet-panel')?.classList.remove('hidden');
            return;
        }
        
        const charName = sheet.data?.name || sheet.character_name || 'Sin nombre';
        
        switch (sheet.status) {
            case 'draft':
                document.getElementById('draft-sheet-panel')?.classList.remove('hidden');
                document.getElementById('draft-char-name').textContent = charName;
                break;
                
            case 'pending':
                document.getElementById('pending-sheet-panel')?.classList.remove('hidden');
                document.getElementById('pending-char-name').textContent = charName;
                break;
                
            case 'rejected':
                document.getElementById('rejected-sheet-panel')?.classList.remove('hidden');
                document.getElementById('rejected-char-name').textContent = charName;
                document.getElementById('rejection-reason').textContent = 
                    sheet.rejection_reason || 'El GM no ha especificado el motivo';
                break;
                
            case 'approved':
                document.getElementById('approved-sheet-panel')?.classList.remove('hidden');
                document.getElementById('approved-char-name').textContent = charName;
                break;
                
            case 'in_game':
                document.getElementById('ingame-sheet-panel')?.classList.remove('hidden');
                document.getElementById('ingame-char-name').textContent = charName;
                document.getElementById('assigned-token').textContent = `#${sheet.marker_id}`;
                break;
        }
    }
    
    // === Pantalla de Formulario ===
    
    showFormScreen() {
        console.log('📝 showFormScreen() llamado');
        console.log('   currentSystem:', this.currentSystem?.id);
        
        // Ocultar todos los formularios específicos primero
        this.hideAllSpecificForms();
        
        // Determinar qué formulario mostrar según el sistema
        if (this.currentSystem?.id === 'dnd5e') {
            this.setupDnDForm();
        } else if (this.currentSystem?.id === 'battletech') {
            this.setupBattleTechForm();
        } else {
            this.buildFormFields();
        }
        
        if (this.app && this.app.showScreen) {
            this.app.showScreen('sheet-form-screen');
        } else {
            console.error('❌ app.showScreen no disponible');
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.getElementById('sheet-form-screen')?.classList.add('active');
        }
        
        // Si hay datos previos, rellenarlos
        if (this.mySheet?.data) {
            this.fillFormWithData(this.mySheet.data);
        }
    }
    
    hideAllSpecificForms() {
        const form = document.getElementById('character-sheet-form');
        
        // Ocultar elementos D&D
        const dndElements = form.querySelectorAll('.sheet-header, .sheet-top-row, .sheet-row, .sheet-main, .saving-throws, .skills-section, .equipment-section, .spells-section, .features-section, .personality-section');
        dndElements.forEach(el => el.style.display = 'none');
        
        // Ocultar BattleTech
        document.getElementById('battletech-sheet')?.classList.add('hidden');
        
        // Ocultar genérico
        document.getElementById('form-fields-container')?.classList.add('hidden');
        
        // IMPORTANTE: Quitar required de todos los campos ocultos para evitar errores de validación
        const dndRequiredFields = form.querySelectorAll('#field-name, #field-class, #field-race');
        dndRequiredFields.forEach(field => field.removeAttribute('required'));
        
        const btRequiredFields = form.querySelectorAll('#bt-name, #bt-mech_model');
        btRequiredFields.forEach(field => field.removeAttribute('required'));
        
        // Reset form classes
        form.classList.remove('dnd-sheet', 'sheet-form');
    }
    
    setupDnDForm() {
        // Mostrar el formulario D&D y ocultar el genérico
        const form = document.getElementById('character-sheet-form');
        const genericContainer = document.getElementById('form-fields-container');
        
        form.classList.add('dnd-sheet');
        form.classList.remove('sheet-form');
        genericContainer?.classList.add('hidden');
        document.getElementById('battletech-sheet')?.classList.add('hidden');
        
        // Mostrar los elementos específicos de D&D
        const dndElements = form.querySelectorAll('.sheet-header, .sheet-top-row, .sheet-row, .sheet-main, .saving-throws, .skills-section, .equipment-section, .spells-section, .features-section, .personality-section');
        dndElements.forEach(el => el.style.display = '');
        
        // IMPORTANTE: Restaurar required en campos D&D visibles
        const dndRequiredFields = form.querySelectorAll('#field-name, #field-class, #field-race');
        dndRequiredFields.forEach(field => {
            field.setAttribute('required', '');
        });
        
        // Deshabilitar required en campos BattleTech ocultos
        const btRequiredFields = form.querySelectorAll('#bt-name, #bt-mech_model');
        btRequiredFields.forEach(field => {
            field.removeAttribute('required');
        });
        
        // Poblar los selects con opciones
        this.populateDnDSelects();
        
        // Configurar listeners para calcular modificadores
        this.setupAttributeModifiers();
        
        // Mostrar/ocultar sección de conjuros según la clase
        this.setupSpellsVisibility();
    }
    
    populateDnDSelects() {
        // Razas
        const raceSelect = document.getElementById('field-race');
        if (raceSelect && raceSelect.options.length <= 1) {
            const races = ["Humano", "Elfo", "Enano", "Halfling", "Gnomo", "Semielfo", "Semiorco", "Tiefling", "Dracónido"];
            races.forEach(race => {
                const opt = document.createElement('option');
                opt.value = race;
                opt.textContent = race;
                raceSelect.appendChild(opt);
            });
        }
        
        // Clases
        const classSelect = document.getElementById('field-class');
        if (classSelect && classSelect.options.length <= 1) {
            const classes = ["Bárbaro", "Bardo", "Clérigo", "Druida", "Guerrero", "Monje", "Paladín", "Explorador", "Pícaro", "Hechicero", "Brujo", "Mago"];
            classes.forEach(cls => {
                const opt = document.createElement('option');
                opt.value = cls;
                opt.textContent = cls;
                classSelect.appendChild(opt);
            });
            
            // Listener para mostrar/ocultar conjuros
            classSelect.addEventListener('change', () => this.setupSpellsVisibility());
        }
        
        // Alineamiento
        const alignSelect = document.getElementById('field-alignment');
        if (alignSelect && alignSelect.options.length <= 1) {
            const alignments = ["Legal Bueno", "Neutral Bueno", "Caótico Bueno", "Legal Neutral", "Neutral", "Caótico Neutral", "Legal Malvado", "Neutral Malvado", "Caótico Malvado"];
            alignments.forEach(align => {
                const opt = document.createElement('option');
                opt.value = align;
                opt.textContent = align;
                alignSelect.appendChild(opt);
            });
        }
    }
    
    // === BATTLETECH FORM ===
    
    setupBattleTechForm() {
        const form = document.getElementById('character-sheet-form');
        const btSheet = document.getElementById('battletech-sheet');
        
        // Ocultar D&D y genérico
        const dndElements = form.querySelectorAll('.sheet-header, .sheet-top-row, .sheet-row, .sheet-main, .saving-throws, .skills-section, .equipment-section, .spells-section, .features-section, .personality-section');
        dndElements.forEach(el => el.style.display = 'none');
        document.getElementById('form-fields-container')?.classList.add('hidden');
        
        // IMPORTANTE: Deshabilitar required en campos D&D ocultos para evitar errores de validación
        const dndRequiredFields = form.querySelectorAll('#field-name, #field-class, #field-race');
        dndRequiredFields.forEach(field => {
            field.removeAttribute('required');
            field.setAttribute('data-was-required', 'true');
        });
        
        // Mostrar BattleTech
        btSheet?.classList.remove('hidden');
        form.classList.remove('dnd-sheet', 'sheet-form');
        
        // Activar required en campos BattleTech visibles
        const btRequiredFields = form.querySelectorAll('#bt-name, #bt-mech_model');
        btRequiredFields.forEach(field => {
            field.setAttribute('required', '');
        });
        
        // Configurar listeners
        this.setupBattleTechListeners();
    }
    
    setupBattleTechListeners() {
        // Auto-calcular Run MP basado en Walk MP
        const walkInput = document.getElementById('bt-walk_mp');
        const runInput = document.getElementById('bt-run_mp');
        
        if (walkInput && runInput) {
            walkInput.addEventListener('input', () => {
                const walkMP = parseInt(walkInput.value) || 0;
                runInput.value = Math.ceil(walkMP * 1.5);
            });
        }
        
        // Botón agregar arma
        const addWeaponBtn = document.getElementById('btn-add-weapon');
        if (addWeaponBtn) {
            addWeaponBtn.addEventListener('click', () => this.addBattleTechWeapon());
        }
        
        // Actualizar visualización de calor
        const heatInput = document.getElementById('bt-current_heat');
        if (heatInput) {
            heatInput.addEventListener('input', () => this.updateHeatDisplay());
        }
    }
    
    addBattleTechWeapon() {
        const weaponsList = document.getElementById('bt-weapons-list');
        if (!weaponsList) return;
        
        const weaponId = Date.now();
        const weaponRow = document.createElement('div');
        weaponRow.className = 'weapon-row';
        weaponRow.innerHTML = `
            <input type="text" name="weapon_name_${weaponId}" placeholder="Weapon">
            <select name="weapon_loc_${weaponId}">
                <option value="LA">LA</option>
                <option value="RA">RA</option>
                <option value="LT">LT</option>
                <option value="RT">RT</option>
                <option value="CT">CT</option>
                <option value="HD">HD</option>
            </select>
            <input type="text" name="weapon_dmg_${weaponId}" placeholder="Dmg">
            <input type="number" name="weapon_heat_${weaponId}" placeholder="H" min="0">
            <input type="text" name="weapon_rng_${weaponId}" placeholder="S/M/L">
        `;
        weaponsList.appendChild(weaponRow);
    }
    
    updateHeatDisplay() {
        const heatInput = document.getElementById('bt-current_heat');
        if (!heatInput) return;
        
        const heat = parseInt(heatInput.value) || 0;
        
        // Cambiar color según nivel de calor
        if (heat >= 15) {
            heatInput.style.borderColor = '#ff0000';
            heatInput.style.color = '#ff0000';
        } else if (heat >= 10) {
            heatInput.style.borderColor = '#ff8800';
            heatInput.style.color = '#ff8800';
        } else if (heat >= 5) {
            heatInput.style.borderColor = '#ffff00';
            heatInput.style.color = '#ffff00';
        } else {
            heatInput.style.borderColor = '#00ff00';
            heatInput.style.color = '#00ff00';
        }
    }
    
    setupAttributeModifiers() {
        const attributes = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
        
        attributes.forEach(attr => {
            const input = document.getElementById(`field-${attr}`);
            const modSpan = document.getElementById(`mod-${attr}`);
            
            if (input && modSpan) {
                const updateModifier = () => {
                    const value = parseInt(input.value) || 10;
                    const modifier = Math.floor((value - 10) / 2);
                    modSpan.textContent = modifier >= 0 ? `+${modifier}` : modifier.toString();
                };
                
                input.addEventListener('input', updateModifier);
                updateModifier(); // Calcular valor inicial
            }
        });
    }
    
    setupSpellsVisibility() {
        const classSelect = document.getElementById('field-class');
        const spellsSection = document.getElementById('spells-section');
        
        if (!classSelect || !spellsSection) return;
        
        const magicClasses = ["Bardo", "Clérigo", "Druida", "Hechicero", "Brujo", "Mago", "Paladín", "Explorador"];
        const selectedClass = classSelect.value;
        
        if (magicClasses.includes(selectedClass)) {
            spellsSection.style.display = 'block';
        } else {
            spellsSection.style.display = 'none';
        }
    }
    
    buildFormFields() {
        const form = document.getElementById('character-sheet-form');
        const container = document.getElementById('form-fields-container');
        if (!container) return;
        
        // Para sistemas que no son D&D 5e, usar el formulario genérico
        form.classList.remove('dnd-sheet');
        form.classList.add('sheet-form');
        container.classList.remove('hidden');
        
        // Ocultar los elementos específicos de D&D
        const dndElements = form.querySelectorAll('.sheet-header, .sheet-top-row, .sheet-row, .sheet-main, .saving-throws, .skills-section, .equipment-section, .spells-section, .features-section, .personality-section');
        dndElements.forEach(el => el.style.display = 'none');
        
        container.innerHTML = '';
        
        if (!this.systemTemplate || this.systemTemplate.length === 0) {
            container.innerHTML = `
                <div class="form-section">
                    <div class="form-group">
                        <label for="field-name">Nombre del Personaje *</label>
                        <input type="text" id="field-name" name="name" required>
                    </div>
                    <div class="form-group">
                        <label for="field-class">Clase/Tipo</label>
                        <input type="text" id="field-class" name="class">
                    </div>
                    <div class="form-group">
                        <label for="field-hp">Puntos de Golpe</label>
                        <input type="number" id="field-hp" name="hp" min="1" value="10">
                    </div>
                    <div class="form-group">
                        <label for="field-max_hp">PG Máximos</label>
                        <input type="number" id="field-max_hp" name="max_hp" min="1" value="10">
                    </div>
                </div>
            `;
            return;
        }
        
        // Generar campos desde el template
        let html = '<div class="form-section">';
        
        this.systemTemplate.forEach((field, index) => {
            html += this.renderFormField(field);
        });
        
        html += '</div>';
        container.innerHTML = html;
    }
    
    renderFormField(field) {
        const required = field.required ? 'required' : '';
        const requiredMark = field.required ? ' *' : '';
        const fieldId = `field-${field.id}`;
        
        let input = '';
        
        switch (field.type) {
            case 'text':
                input = `<input type="text" id="${fieldId}" name="${field.id}" ${required} 
                         ${field.default ? `value="${field.default}"` : ''}>`;
                break;
                
            case 'number':
                input = `<input type="number" id="${fieldId}" name="${field.id}" 
                         ${field.min !== undefined ? `min="${field.min}"` : ''} 
                         ${field.max !== undefined ? `max="${field.max}"` : ''} 
                         ${field.default !== undefined ? `value="${field.default}"` : ''} 
                         ${required}>`;
                break;
                
            case 'select':
                const options = (field.options || []).map(opt => 
                    `<option value="${opt}">${opt}</option>`
                ).join('');
                input = `<select id="${fieldId}" name="${field.id}" ${required}>
                    <option value="">Selecciona...</option>
                    ${options}
                </select>`;
                break;
                
            case 'textarea':
                input = `<textarea id="${fieldId}" name="${field.id}" rows="3" ${required}></textarea>`;
                break;
                
            case 'multiselect':
                const checkboxes = (field.options || []).map(opt => `
                    <label class="checkbox-label">
                        <input type="checkbox" name="${field.id}" value="${opt}">
                        <span>${opt}</span>
                    </label>
                `).join('');
                input = `<div class="checkbox-group">${checkboxes}</div>`;
                break;
                
            default:
                input = `<input type="text" id="${fieldId}" name="${field.id}" ${required}>`;
        }
        
        return `
            <div class="form-group ${field.type === 'textarea' ? 'full-width' : ''}">
                <label for="${fieldId}">${field.name}${requiredMark}</label>
                ${input}
            </div>
        `;
    }
    
    fillFormWithData(data) {
        Object.entries(data).forEach(([key, value]) => {
            const field = document.querySelector(`[name="${key}"]`);
            if (!field) return;
            
            if (field.type === 'checkbox') {
                // Para multiselect
                const checkboxes = document.querySelectorAll(`[name="${key}"]`);
                const values = Array.isArray(value) ? value : [value];
                checkboxes.forEach(cb => {
                    cb.checked = values.includes(cb.value);
                });
            } else {
                field.value = value;
            }
        });
    }
    
    getFormData() {
        const form = document.getElementById('character-sheet-form');
        const formData = new FormData(form);
        const data = {};
        
        // Agrupar checkboxes (multiselect)
        const processed = new Set();
        
        for (const [key, value] of formData.entries()) {
            if (processed.has(key)) continue;
            
            const fields = form.querySelectorAll(`[name="${key}"]`);
            if (fields.length > 1 && fields[0].type === 'checkbox') {
                // Multiselect
                data[key] = Array.from(fields)
                    .filter(f => f.checked)
                    .map(f => f.value);
                processed.add(key);
            } else {
                data[key] = value;
            }
        }
        
        return data;
    }
    
    backToStatus() {
        this.app.showScreen('sheet-status-screen');
    }
    
    // === Guardar y Enviar ===
    
    async saveDraft() {
        const data = this.getFormData();
        
        if (!data.name) {
            this.app.showToast('El nombre es obligatorio', 'error');
            return;
        }
        
        try {
            let response;
            
            if (this.sheetId) {
                // Actualizar ficha existente
                response = await fetch(`/api/sheets/${this.sheetId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        player_id: this.app.playerId,
                        data: data
                    })
                });
            } else {
                // Crear nueva ficha
                response = await fetch('/api/sheets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        player_id: this.app.playerId,
                        player_name: this.app.playerName,
                        data: data
                    })
                });
            }
            
            if (response.ok) {
                const result = await response.json();
                this.mySheet = result.sheet;
                this.sheetId = result.sheet.id;
                this.app.showToast('✓ Borrador guardado');
                this.updateSheetStatus(this.mySheet);
                this.backToStatus();
            } else {
                throw new Error('Error al guardar');
            }
        } catch (error) {
            console.error('Error guardando borrador:', error);
            this.app.showToast('Error al guardar', 'error');
        }
    }
    
    async submitSheet() {
        // Primero guardar si hay cambios
        if (this.app.currentScreen === 'sheet-form-screen') {
            const data = this.getFormData();
            if (!data.name) {
                this.app.showToast('El nombre es obligatorio', 'error');
                return;
            }
            
            // Guardar primero
            try {
                if (!this.sheetId) {
                    const response = await fetch('/api/sheets', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            player_id: this.app.playerId,
                            player_name: this.app.playerName,
                            data: data
                        })
                    });
                    const result = await response.json();
                    this.sheetId = result.sheet.id;
                } else {
                    await fetch(`/api/sheets/${this.sheetId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            player_id: this.app.playerId,
                            data: data
                        })
                    });
                }
            } catch (error) {
                console.error('Error guardando antes de enviar:', error);
                this.app.showToast('Error al guardar', 'error');
                return;
            }
        }
        
        if (!this.sheetId) {
            this.app.showToast('No hay ficha para enviar', 'error');
            return;
        }
        
        try {
            const response = await fetch(`/api/sheets/${this.sheetId}/submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    player_id: this.app.playerId
                })
            });
            
            if (response.ok) {
                this.app.showToast('📤 Ficha enviada al GM');
                // Actualizar estado local
                if (this.mySheet) {
                    this.mySheet.status = 'pending';
                    this.updateSheetStatus(this.mySheet);
                }
                this.backToStatus();
            } else {
                throw new Error('Error al enviar');
            }
        } catch (error) {
            console.error('Error enviando ficha:', error);
            this.app.showToast('Error al enviar ficha', 'error');
        }
    }
    
    goToControl() {
        // Configurar el personaje en la app principal y mostrar control
        if (this.mySheet && this.mySheet.marker_id) {
            this.app.selectedCharacterId = `sheet_${this.sheetId}`;
            this.app.myCharacter = {
                id: this.app.selectedCharacterId,
                name: this.mySheet.data?.name || 'Sin nombre',
                character_class: this.mySheet.data?.class || this.mySheet.data?.mech_model || '',
                hp: this.mySheet.data?.hp || 100,
                max_hp: this.mySheet.data?.max_hp || 100,
                mana: this.mySheet.data?.mana || 0,
                max_mana: this.mySheet.data?.max_mana || 0,
                marker_id: this.mySheet.marker_id
            };
            this.app.showScreen('control-screen');
            this.app.updateControlScreen();
        }
    }
    
    // === Escaneo de Fichas ===
    
    async showScanScreen() {
        console.log('📷 showScanScreen() llamado');
        
        if (this.app && this.app.showScreen) {
            this.app.showScreen('scan-screen');
        } else {
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.getElementById('scan-screen')?.classList.add('active');
        }
        
        await this.startCamera();
    }
    
    async startCamera() {
        try {
            const video = document.getElementById('camera-video');
            if (!video) {
                console.error('Video element not found');
                this.app.showToast('Error: elemento de video no encontrado', 'error');
                return;
            }
            
            // Verificar si mediaDevices está disponible (requiere HTTPS o localhost)
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                console.error('📷 mediaDevices no disponible. Requiere HTTPS.');
                this.app.showToast('⚠️ La cámara requiere conexión HTTPS. Usa localhost o configura SSL.', 'error');
                
                // Mostrar mensaje en el área de la cámara
                const preview = document.querySelector('.camera-preview');
                if (preview) {
                    preview.innerHTML = `
                        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 20px; text-align: center; color: #fff;">
                            <span style="font-size: 48px;">🔒</span>
                            <h3 style="margin: 10px 0;">Conexión Segura Requerida</h3>
                            <p style="font-size: 14px; opacity: 0.8;">La cámara solo funciona con HTTPS o en localhost.</p>
                            <p style="font-size: 12px; opacity: 0.6; margin-top: 10px;">Contacta al administrador para configurar SSL.</p>
                        </div>
                    `;
                }
                return;
            }
            
            console.log('📷 Solicitando acceso a la cámara...');
            
            this.cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    facingMode: 'environment',
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            });
            
            console.log('📷 Stream obtenido:', this.cameraStream);
            
            video.srcObject = this.cameraStream;
            
            // Esperar a que el video esté listo para reproducir
            video.onloadedmetadata = () => {
                console.log('📷 Video metadata cargada, dimensiones:', video.videoWidth, 'x', video.videoHeight);
                video.play().then(() => {
                    console.log('📷 Video reproduciendo');
                }).catch(err => {
                    console.error('Error al reproducir video:', err);
                });
            };
            
            // También intentar play directamente
            try {
                await video.play();
                console.log('📷 Video.play() exitoso');
            } catch (playError) {
                console.log('📷 Esperando onloadedmetadata para play()');
            }
            
            document.getElementById('scan-result')?.classList.add('hidden');
            document.getElementById('scan-processing')?.classList.add('hidden');
            video.classList.remove('hidden');
            
        } catch (error) {
            console.error('Error accediendo a la cámara:', error);
            
            // Mensajes de error más específicos
            let errorMsg = 'No se pudo acceder a la cámara';
            if (error.name === 'NotAllowedError') {
                errorMsg = 'Permiso de cámara denegado. Por favor, permite el acceso.';
            } else if (error.name === 'NotFoundError') {
                errorMsg = 'No se encontró ninguna cámara en el dispositivo.';
            } else if (error.name === 'NotReadableError') {
                errorMsg = 'La cámara está siendo usada por otra aplicación.';
            } else if (error.name === 'OverconstrainedError') {
                errorMsg = 'La configuración de cámara no es compatible.';
            }
            
            this.app.showToast(errorMsg, 'error');
        }
    }
    
    stopCamera() {
        if (this.cameraStream) {
            this.cameraStream.getTracks().forEach(track => track.stop());
            this.cameraStream = null;
        }
    }
    
    closeScanScreen() {
        this.stopCamera();
        this.app.showScreen('sheet-status-screen');
    }
    
    captureImage() {
        const video = document.getElementById('camera-video');
        const canvas = document.getElementById('camera-canvas');
        const capturedImg = document.getElementById('captured-image');
        
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0);
        
        const imageData = canvas.toDataURL('image/jpeg', 0.8);
        capturedImg.src = imageData;
        
        video.classList.add('hidden');
        document.getElementById('scan-result')?.classList.remove('hidden');
    }
    
    retryScan() {
        document.getElementById('scan-result')?.classList.add('hidden');
        document.getElementById('camera-video')?.classList.remove('hidden');
    }
    
    async processScannedImage() {
        const capturedImg = document.getElementById('captured-image');
        const processing = document.getElementById('scan-processing');
        const result = document.getElementById('scan-result');
        
        result?.classList.add('hidden');
        processing?.classList.remove('hidden');
        
        try {
            // Enviar imagen al servidor para OCR
            const response = await fetch('/api/sheets/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: capturedImg.src,
                    system_id: this.currentSystem?.id || 'generic',
                    player_id: this.app.playerId
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                
                if (data.success && data.extracted_data) {
                    // Rellenar formulario con datos extraídos
                    this.mySheet = { data: data.extracted_data };
                    this.app.showToast('✓ Ficha escaneada correctamente');
                    this.stopCamera();
                    this.showFormScreen();
                    this.fillFormWithData(data.extracted_data);
                } else {
                    throw new Error(data.message || 'No se pudo extraer datos');
                }
            } else {
                throw new Error('Error del servidor');
            }
        } catch (error) {
            console.error('Error procesando imagen:', error);
            this.app.showToast('No se pudo procesar la imagen. Prueba con mejor iluminación.', 'error');
            processing?.classList.add('hidden');
            result?.classList.remove('hidden');
        }
    }
    
    downloadPDF(e) {
        // El enlace ya tiene el href configurado
        // Solo mostrar mensaje
        this.app.showToast('📄 Descargando PDF...');
    }
}

// Inicializar cuando la app esté lista
document.addEventListener('DOMContentLoaded', () => {
    // Se inicializará desde app.js cuando MobileApp esté listo
});
