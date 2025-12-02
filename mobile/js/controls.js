/**
 * MesaRPG - Controles adicionales para móvil
 * Gestos táctiles y feedback háptico
 */

class MobileControls {
    constructor(app) {
        this.app = app;
        this.touchStartY = 0;
        this.init();
    }
    
    init() {
        // Prevenir zoom con doble tap
        document.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1) {
                e.preventDefault();
            }
        }, { passive: false });
        
        let lastTouchEnd = 0;
        document.addEventListener('touchend', (e) => {
            const now = Date.now();
            if (now - lastTouchEnd <= 300) {
                e.preventDefault();
            }
            lastTouchEnd = now;
        }, false);
        
        // Pull to refresh deshabilitado
        document.body.addEventListener('touchmove', (e) => {
            if (e.touches.length > 1) {
                e.preventDefault();
            }
        }, { passive: false });
        
        // Vibración para feedback
        this.setupHapticFeedback();
    }
    
    setupHapticFeedback() {
        // Añadir vibración a botones
        document.querySelectorAll('.btn, .ability-btn, .btn-action').forEach(btn => {
            btn.addEventListener('touchstart', () => {
                this.vibrate(10);
            });
        });
        
        // Observer para nuevos botones añadidos dinámicamente
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) {
                        const buttons = node.querySelectorAll ? 
                            node.querySelectorAll('.btn, .ability-btn, .btn-action') : [];
                        buttons.forEach(btn => {
                            btn.addEventListener('touchstart', () => {
                                this.vibrate(10);
                            });
                        });
                    }
                });
            });
        });
        
        observer.observe(document.body, { childList: true, subtree: true });
    }
    
    vibrate(duration = 50) {
        if (navigator.vibrate) {
            navigator.vibrate(duration);
        }
    }
    
    vibratePattern(pattern) {
        if (navigator.vibrate) {
            navigator.vibrate(pattern);
        }
    }
    
    // Vibración para eventos importantes
    onDamageReceived() {
        this.vibratePattern([100, 50, 100, 50, 100]);
    }
    
    onMyTurn() {
        this.vibratePattern([200, 100, 200]);
    }
    
    onAbilityUsed() {
        this.vibrate(50);
    }
    
    onCriticalHit() {
        this.vibratePattern([50, 30, 50, 30, 200]);
    }
}

// Inicializar cuando la app esté lista
document.addEventListener('DOMContentLoaded', () => {
    // Esperar a que la app esté inicializada
    setTimeout(() => {
        if (window.app) {
            window.mobileControls = new MobileControls(window.app);
        }
    }, 100);
});


// === Utilidades adicionales ===

// Formatear números grandes
function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
}

// Calcular distancia entre dos puntos
function distance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// Animación de shake para elementos
function shakeElement(element) {
    element.style.animation = 'none';
    element.offsetHeight; // Trigger reflow
    element.style.animation = 'shake 0.5s ease';
}

// Añadir keyframes de shake si no existe
if (!document.querySelector('#shake-keyframes')) {
    const style = document.createElement('style');
    style.id = 'shake-keyframes';
    style.textContent = `
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            20%, 60% { transform: translateX(-5px); }
            40%, 80% { transform: translateX(5px); }
        }
    `;
    document.head.appendChild(style);
}
