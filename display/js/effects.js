/**
 * MesaRPG - Sistema de Efectos Visuales
 * Partículas, animaciones y efectos de habilidades
 */

class EffectsManager {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.effects = [];
        this.running = false;
        
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }
    
    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    
    start() {
        if (this.running) return;
        this.running = true;
        this.animate();
    }
    
    stop() {
        this.running = false;
    }
    
    animate() {
        if (!this.running) return;
        
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Actualizar y dibujar partículas
        this.particles = this.particles.filter(p => {
            p.update();
            p.draw(this.ctx);
            return p.isAlive();
        });
        
        // Actualizar y dibujar efectos
        this.effects = this.effects.filter(e => {
            e.update();
            e.draw(this.ctx);
            return e.isAlive();
        });
        
        requestAnimationFrame(() => this.animate());
    }
    
    // === Efectos de habilidades ===
    
    playEffect(effectData) {
        const type = effectData.type || 'attack';
        const source = effectData.source_position;
        const target = effectData.target_position;
        const aoe = effectData.aoe || 0;
        
        console.log('🎆 Reproduciendo efecto:', type, effectData);
        
        switch (type) {
            case 'fire':
                this.fireEffect(source, target, aoe);
                break;
            case 'ice':
                this.iceEffect(source, target, aoe);
                break;
            case 'lightning':
                this.lightningEffect(source, target);
                break;
            case 'heal':
                this.healEffect(target || source, aoe);
                break;
            case 'shield':
                this.shieldEffect(source);
                break;
            case 'attack':
            default:
                this.attackEffect(source, target);
                break;
        }
        
        // Reproducir sonido si hay
        if (effectData.sound) {
            this.playSound(effectData.sound);
        }
    }
    
    fireEffect(source, target, aoe) {
        if (!source) return;
        
        // Partículas de fuego desde la fuente al objetivo
        const steps = 30;
        for (let i = 0; i < steps; i++) {
            setTimeout(() => {
                const progress = i / steps;
                const x = target ? 
                    source.x + (target.x - source.x) * progress :
                    source.x;
                const y = target ?
                    source.y + (target.y - source.y) * progress :
                    source.y;
                
                for (let j = 0; j < 5; j++) {
                    this.particles.push(new FireParticle(x, y));
                }
            }, i * 20);
        }
        
        // Explosión en el objetivo
        if (target) {
            setTimeout(() => {
                this.explosion(target.x, target.y, '#ff5722', '#ff9800', aoe || 50);
            }, steps * 20);
        }
    }
    
    iceEffect(source, target, aoe) {
        if (!target) return;
        
        // Cristales de hielo
        for (let i = 0; i < 20; i++) {
            setTimeout(() => {
                this.particles.push(new IceParticle(target.x, target.y, aoe || 30));
            }, i * 30);
        }
        
        // Área congelada
        if (aoe > 0) {
            this.showAOE(target.x, target.y, aoe * 20, 'ice');
        }
    }
    
    lightningEffect(source, target) {
        if (!source || !target) return;
        
        // Dibujar rayo
        this.effects.push(new LightningBolt(source, target));
        
        // Partículas de chispa
        for (let i = 0; i < 15; i++) {
            this.particles.push(new SparkParticle(target.x, target.y));
        }
    }
    
    healEffect(target, aoe) {
        if (!target) return;
        
        // Partículas verdes ascendentes
        for (let i = 0; i < 30; i++) {
            setTimeout(() => {
                this.particles.push(new HealParticle(target.x, target.y, aoe || 30));
            }, i * 50);
        }
    }
    
    shieldEffect(target) {
        if (!target) return;
        
        this.effects.push(new ShieldEffect(target.x, target.y));
    }
    
    attackEffect(source, target) {
        if (!source || !target) return;
        
        // Línea de ataque
        this.effects.push(new AttackLine(source, target));
        
        // Partículas de impacto
        for (let i = 0; i < 10; i++) {
            this.particles.push(new ImpactParticle(target.x, target.y));
        }
    }
    
    explosion(x, y, colorInner, colorOuter, size) {
        // Crear muchas partículas
        for (let i = 0; i < 40; i++) {
            const angle = (Math.PI * 2 * i) / 40;
            const speed = 2 + Math.random() * 3;
            this.particles.push(new ExplosionParticle(x, y, angle, speed, colorInner, colorOuter));
        }
    }
    
    showAOE(x, y, radius, type) {
        this.effects.push(new AOEIndicator(x, y, radius, type));
    }
    
    // === Números flotantes ===
    
    showDamage(x, y, amount, isCritical = false) {
        this.createFloatingNumber(x, y, `-${amount}`, 'damage', isCritical);
    }
    
    showHeal(x, y, amount) {
        this.createFloatingNumber(x, y, `+${amount}`, 'heal', false);
    }
    
    createFloatingNumber(x, y, text, type, isCritical) {
        const el = document.createElement('div');
        el.className = `floating-number ${type}${isCritical ? ' critical' : ''}`;
        el.textContent = text;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        document.body.appendChild(el);
        
        setTimeout(() => el.remove(), 1500);
    }
    
    // === Sonido ===
    
    playSound(soundName) {
        const audio = new Audio(`assets/sounds/${soundName}.mp3`);
        audio.volume = 0.5;
        audio.play().catch(e => console.log('No se pudo reproducir sonido:', e));
    }
}


// === Clases de Partículas ===

class Particle {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.life = 1;
        this.decay = 0.02;
    }
    
    update() {
        this.life -= this.decay;
    }
    
    draw(ctx) {}
    
    isAlive() {
        return this.life > 0;
    }
}

class FireParticle extends Particle {
    constructor(x, y) {
        super(x, y);
        this.vx = (Math.random() - 0.5) * 2;
        this.vy = -Math.random() * 3 - 1;
        this.size = 5 + Math.random() * 10;
        this.decay = 0.03;
    }
    
    update() {
        super.update();
        this.x += this.vx;
        this.y += this.vy;
        this.vy += 0.05; // Gravedad leve
        this.size *= 0.95;
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        const gradient = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.size);
        gradient.addColorStop(0, `rgba(255, 200, 50, ${this.life})`);
        gradient.addColorStop(0.5, `rgba(255, 100, 0, ${this.life * 0.8})`);
        gradient.addColorStop(1, `rgba(255, 50, 0, 0)`);
        ctx.fillStyle = gradient;
        ctx.fill();
    }
}

class IceParticle extends Particle {
    constructor(x, y, spread) {
        super(x + (Math.random() - 0.5) * spread * 2, y + (Math.random() - 0.5) * spread * 2);
        this.size = 3 + Math.random() * 5;
        this.rotation = Math.random() * Math.PI * 2;
        this.decay = 0.015;
    }
    
    update() {
        super.update();
        this.rotation += 0.1;
    }
    
    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rotation);
        ctx.beginPath();
        // Dibujar cristal hexagonal
        for (let i = 0; i < 6; i++) {
            const angle = (Math.PI * 2 * i) / 6;
            const px = Math.cos(angle) * this.size;
            const py = Math.sin(angle) * this.size;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = `rgba(150, 220, 255, ${this.life * 0.8})`;
        ctx.strokeStyle = `rgba(200, 240, 255, ${this.life})`;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }
}

class SparkParticle extends Particle {
    constructor(x, y) {
        super(x, y);
        const angle = Math.random() * Math.PI * 2;
        const speed = 3 + Math.random() * 5;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        this.decay = 0.05;
    }
    
    update() {
        super.update();
        this.x += this.vx;
        this.y += this.vy;
        this.vx *= 0.95;
        this.vy *= 0.95;
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.moveTo(this.x - this.vx * 3, this.y - this.vy * 3);
        ctx.lineTo(this.x, this.y);
        ctx.strokeStyle = `rgba(255, 255, 100, ${this.life})`;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

class HealParticle extends Particle {
    constructor(x, y, spread) {
        super(x + (Math.random() - 0.5) * spread, y);
        this.vy = -1 - Math.random() * 2;
        this.size = 3 + Math.random() * 4;
        this.decay = 0.02;
    }
    
    update() {
        super.update();
        this.y += this.vy;
        this.x += Math.sin(this.y * 0.05) * 0.5;
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(100, 255, 100, ${this.life * 0.8})`;
        ctx.fill();
        
        // Cruz de curación
        ctx.strokeStyle = `rgba(200, 255, 200, ${this.life})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.x - this.size, this.y);
        ctx.lineTo(this.x + this.size, this.y);
        ctx.moveTo(this.x, this.y - this.size);
        ctx.lineTo(this.x, this.y + this.size);
        ctx.stroke();
    }
}

class ExplosionParticle extends Particle {
    constructor(x, y, angle, speed, colorInner, colorOuter) {
        super(x, y);
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        this.colorInner = colorInner;
        this.colorOuter = colorOuter;
        this.size = 5 + Math.random() * 10;
        this.decay = 0.03;
    }
    
    update() {
        super.update();
        this.x += this.vx;
        this.y += this.vy;
        this.vx *= 0.96;
        this.vy *= 0.96;
        this.size *= 0.97;
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        const gradient = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.size);
        gradient.addColorStop(0, this.colorInner);
        gradient.addColorStop(1, this.colorOuter);
        ctx.fillStyle = gradient;
        ctx.globalAlpha = this.life;
        ctx.fill();
        ctx.globalAlpha = 1;
    }
}

class ImpactParticle extends Particle {
    constructor(x, y) {
        super(x, y);
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 3;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        this.size = 3 + Math.random() * 3;
        this.decay = 0.04;
    }
    
    update() {
        super.update();
        this.x += this.vx;
        this.y += this.vy;
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${this.life})`;
        ctx.fill();
    }
}


// === Clases de Efectos ===

class Effect {
    constructor() {
        this.life = 1;
    }
    
    update() {
        this.life -= 0.02;
    }
    
    draw(ctx) {}
    
    isAlive() {
        return this.life > 0;
    }
}

class LightningBolt extends Effect {
    constructor(source, target) {
        super();
        this.source = source;
        this.target = target;
        this.points = this.generatePoints();
        this.life = 0.3;
    }
    
    generatePoints() {
        const points = [this.source];
        const segments = 8;
        
        for (let i = 1; i < segments; i++) {
            const t = i / segments;
            const x = this.source.x + (this.target.x - this.source.x) * t;
            const y = this.source.y + (this.target.y - this.source.y) * t;
            points.push({
                x: x + (Math.random() - 0.5) * 30,
                y: y + (Math.random() - 0.5) * 30
            });
        }
        
        points.push(this.target);
        return points;
    }
    
    update() {
        this.life -= 0.1;
        // Regenerar puntos para efecto de parpadeo
        if (Math.random() > 0.5) {
            this.points = this.generatePoints();
        }
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.moveTo(this.points[0].x, this.points[0].y);
        
        for (let i = 1; i < this.points.length; i++) {
            ctx.lineTo(this.points[i].x, this.points[i].y);
        }
        
        ctx.strokeStyle = `rgba(150, 200, 255, ${this.life})`;
        ctx.lineWidth = 4;
        ctx.stroke();
        
        ctx.strokeStyle = `rgba(255, 255, 255, ${this.life})`;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

class ShieldEffect extends Effect {
    constructor(x, y) {
        super();
        this.x = x;
        this.y = y;
        this.radius = 0;
        this.maxRadius = 50;
    }
    
    update() {
        this.life -= 0.01;
        this.radius = Math.min(this.radius + 3, this.maxRadius);
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(100, 200, 255, ${this.life})`;
        ctx.lineWidth = 3;
        ctx.stroke();
        
        ctx.fillStyle = `rgba(100, 200, 255, ${this.life * 0.2})`;
        ctx.fill();
    }
}

class AttackLine extends Effect {
    constructor(source, target) {
        super();
        this.source = source;
        this.target = target;
        this.life = 0.5;
    }
    
    update() {
        this.life -= 0.05;
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.moveTo(this.source.x, this.source.y);
        ctx.lineTo(this.target.x, this.target.y);
        ctx.strokeStyle = `rgba(255, 70, 70, ${this.life})`;
        ctx.lineWidth = 3;
        ctx.stroke();
    }
}

class AOEIndicator extends Effect {
    constructor(x, y, radius, type) {
        super();
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.type = type;
        this.life = 2;
    }
    
    update() {
        this.life -= 0.02;
    }
    
    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        
        let color;
        switch (this.type) {
            case 'fire': color = '255, 100, 50'; break;
            case 'ice': color = '100, 200, 255'; break;
            case 'heal': color = '100, 255, 100'; break;
            default: color = '255, 255, 255';
        }
        
        ctx.fillStyle = `rgba(${color}, ${this.life * 0.2})`;
        ctx.fill();
        
        ctx.strokeStyle = `rgba(${color}, ${this.life * 0.8})`;
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}


// Instancia global
window.effectsManager = new EffectsManager('effects-canvas');
