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
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Botones de opciones de ficha
        document.getElementById('btn-create-manual')?.addEventListener('click', () => this.showFormScreen());
        document.getElementById('btn-scan-sheet')?.addEventListener('click', () => this.showScanScreen());
        document.getElementById('btn-download-pdf')?.addEventListener('click', (e) => this.downloadPDF(e));
        
        // Botones de estado de ficha
        document.getElementById('btn-edit-sheet')?.addEventListener('click', () => this.showFormScreen());
        document.getElementById('btn-submit-sheet')?.addEventListener('click', () => this.submitSheet());
        document.getElementById('btn-fix-sheet')?.addEventListener('click', () => this.showFormScreen());
        document.getElementById('btn-go-control')?.addEventListener('click', () => this.goToControl());
        
        // Formulario
        document.getElementById('btn-back-from-form')?.addEventListener('click', () => this.backToStatus());
        document.getElementById('btn-save-draft')?.addEventListener('click', () => this.saveDraft());
        document.getElementById('btn-form-save')?.addEventListener('click', () => this.saveDraft());
        document.getElementById('character-sheet-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.submitSheet();
        });
        
        // Escaneo
        document.getElementById('btn-back-from-scan')?.addEventListener('click', () => this.closeScanScreen());
        document.getElementById('btn-capture')?.addEventListener('click', () => this.captureImage());
        document.getElementById('btn-retry-scan')?.addEventListener('click', () => this.retryScan());
        document.getElementById('btn-process-scan')?.addEventListener('click', () => this.processScannedImage());
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
        if (!link || !this.currentSystem) return;
        
        // URLs de PDFs oficiales (puedes cambiarlas por tus propias)
        const pdfUrls = {
            'dnd5e': '/assets/pdfs/dnd5e-character-sheet.pdf',
            'battletech': '/assets/pdfs/battletech-record-sheet.pdf'
        };
        
        const pdfUrl = pdfUrls[this.currentSystem.id];
        if (pdfUrl) {
            link.href = pdfUrl;
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
        this.buildFormFields();
        this.app.showScreen('sheet-form-screen');
        
        // Si hay datos previos, rellenarlos
        if (this.mySheet?.data) {
            this.fillFormWithData(this.mySheet.data);
        }
    }
    
    buildFormFields() {
        const container = document.getElementById('form-fields-container');
        if (!container) return;
        
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
        this.app.showScreen('scan-screen');
        await this.startCamera();
    }
    
    async startCamera() {
        try {
            const video = document.getElementById('camera-video');
            this.cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            });
            video.srcObject = this.cameraStream;
            
            document.getElementById('scan-result')?.classList.add('hidden');
            document.getElementById('scan-processing')?.classList.add('hidden');
            video.classList.remove('hidden');
        } catch (error) {
            console.error('Error accediendo a la cámara:', error);
            this.app.showToast('No se pudo acceder a la cámara', 'error');
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
