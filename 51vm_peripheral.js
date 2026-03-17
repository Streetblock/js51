function get_serial() {
    return new Map([
        [0x98, "SCON"],
        [0x99, "SBUF"],
    ])
}

function get_interrupt() {
    return new Map([
        [0x88, "TCON"],
        [0xA8, "IE"],
        [0xB8, "IP"],
    ])
}

function get_ports() { 
    return new Map([
         [0x80, "P0"],
         [0x90, "P1"],
         [0xA0, "P2"],
         [0xB0, "P3"],
        ])
}

function get_timers() {
    return new Map([
        [0x89, "TMOD"],
        [0x8A, "TL0"],
        [0x8C, "TH0"],
        [0x8B, "TL1"],
        [0x8D, "TH1"]
    ])
}

function install_default_peripherals(cpu){
    let ret = new Map([
        ...cpu.sfr_extend(get_serial()),
        ...cpu.sfr_extend(get_interrupt()),
        ...cpu.sfr_extend(get_ports()),
        ...cpu.sfr_extend(get_timers())
    ])

    let rTCON = ret.get("TCON");
    let rTMOD = ret.get("TMOD");
    let rTL0  = ret.get("TL0");
    let rTH0  = ret.get("TH0");
    let rTL1  = ret.get("TL1");
    let rTH1  = ret.get("TH1");
    let rSCON = ret.get("SCON");
    let rIE   = ret.get("IE");
    let rIP   = ret.get("IP");
    let rP0   = ret.get("P0");
    let rP1   = ret.get("P1");
    let rP2   = ret.get("P2");
    let rP3   = ret.get("P3"); // Port 3 referenzieren für die externen Pins

    // Array aller Ports für eine bequeme Schleife
    let io_ports = [rP0, rP1, rP2, rP3];

    for (let p of io_ports) {
        if (!p) continue; // Sicherheitscheck, falls ein Port fehlt

        // 1. Interner Speicher für das Latch (Was die CPU geschrieben hat)
        // Nach einem Reset sind alle 8051-Ports auf High (0xFF)
        p._latch = 0xFF; 

        // 2. Zustand der externen Hardware (Was von außen anliegt)
        // 1 = unverbunden/High-Z (wird vom Latch dominiert), 0 = hart auf GND gezogen.
        p.ext_pins = 0xFF; 

        // 3. Überschreibe den Schreibzugriff (CPU schreibt ins Register)
        p.set = function (val) {
            // Speichere den Wert im Latch
            this._latch = val & 0xFF;
            
            // Der resultierende Zustand der Pins ist Latch AND Externe Hardware
            let real_pins = this._latch & this.ext_pins; 
            
            // Rufe die Standard-set-Funktion auf, damit Listener getriggert werden
            return this.__proto__.set.call(this, real_pins);
        };

        // 4. Überschreibe den Lesezugriff (CPU liest den Pin-Zustand)
        p.get = function () {
            // Aktualisiere den Wert vor dem Lesen (Latch AND Extern)
            this._value = this._latch & this.ext_pins;
            
            // Rufe die Standard-get-Funktion auf
            return this.__proto__.get.call(this);
        };

        // 5. Neue Funktion für das GUI (Simulation von externer Hardware)
        p.set_ext_pins = function(val) {
            this.ext_pins = val & 0xFF;
            // Aktualisiere sofort den internen _value, damit die CPU es im nächsten Zyklus sieht
            this._value = this._latch & this.ext_pins;
        };
        
        // Initialisiere die Standard-Werte für die Standard-get/set-Logik
        p.set(0xFF);
    }

    let rSBUF = ret.get("SBUF"); // SBUF Referenz holen

    // Callback-Funktion, die vom GUI überschrieben werden kann
    cpu.on_serial_tx = null; 
    // Zähler für eine realistische Sende-Verzögerung
    cpu.serial_tx_delay = 0; 

    // Wir klinken uns in jeden Schreibzugriff auf SBUF ein
    rSBUF.setlistener.push((oldval, newval) => {
        // 1. Daten an das Frontend schicken (z.B. für ein Terminal)
        if (typeof cpu.on_serial_tx === 'function') {
            cpu.on_serial_tx(newval);
        }

        // 2. Hardware-Verhalten simulieren
        // Echte Hardware braucht Zeit zum Senden (Baudrate). 
        // Wir simulieren eine kleine Verzögerung, bevor wir TI setzen, 
        // damit klassische Polling-Schleifen wie "while(!TI);" korrekt arbeiten.
        cpu.serial_tx_delay = 12; // Zyklen-Verzögerung (anpassbar)
    });

    cpu.last_P3 = 0xFF; // Startzustand der Pins (meistens HIGH durch Pull-Ups)

    // =========================================================
    // Hardware Tick: Timer, Counter, GATE und Externe Interrupts
    // =========================================================
    cpu.hardware_tick = function(cycles = 1) {
        let tcon_val = rTCON.get();
        let tmod_val = rTMOD.get();
        let p3_val   = rP3.get();
        let last_p3  = cpu.last_P3;
        cpu.last_P3  = p3_val; // Zustand für den nächsten Tick merken

        // --- 1. PIN-ZUSTÄNDE UND FLANKENERKENNUNG (High-to-Low) ---
        let int0_pin = (p3_val & 0x04) !== 0; // P3.2
        let int1_pin = (p3_val & 0x08) !== 0; // P3.3
        let t0_pin   = (p3_val & 0x10) !== 0; // P3.4
        let t1_pin   = (p3_val & 0x20) !== 0; // P3.5

        let int0_edge = ((last_p3 & 0x04) !== 0) && !int0_pin;
        let int1_edge = ((last_p3 & 0x08) !== 0) && !int1_pin;
        let t0_edge   = ((last_p3 & 0x10) !== 0) && !t0_pin;
        let t1_edge   = ((last_p3 & 0x20) !== 0) && !t1_pin;

        // --- 2. EXTERNE INTERRUPTS (INT0, INT1) AKTUALISIEREN ---
        let it0 = (tcon_val & 0x01); // 1 = Flankengesteuert, 0 = Pegelgesteuert
        let it1 = (tcon_val & 0x04);

        if (it0) { if (int0_edge) tcon_val |= 0x02; } // Flanke: Setze IE0 Flag
        else     { if (!int0_pin) tcon_val |= 0x02; else tcon_val &= ~0x02; } // Pegel: LOW setzt IE0, HIGH löscht es

        if (it1) { if (int1_edge) tcon_val |= 0x08; } // Flanke: Setze IE1 Flag
        else     { if (!int1_pin) tcon_val |= 0x08; else tcon_val &= ~0x08; }

        rTCON.set(tcon_val); // Geänderte Interrupt-Flags ins Register schreiben
        tcon_val = rTCON.get(); // Zur Sicherheit neu laden für die Timer-Logik

        // --- 3. ZÄHLER-LOGIK (GATE, C/T, TR) BERECHNEN ---
        let gate0 = (tmod_val & 0x08) !== 0;
        let ct0   = (tmod_val & 0x04) !== 0;
        let tr0   = (tcon_val & 0x10) !== 0;
        
        let gate1 = (tmod_val & 0x80) !== 0;
        let ct1   = (tmod_val & 0x40) !== 0;
        let tr1   = (tcon_val & 0x40) !== 0;

        // Läuft Timer 0? (Start-Bit UND (Nicht-GATE ODER Pin ist High))
        let timer0_run = tr0 && (!gate0 || int0_pin);
        let timer1_run = tr1 && (!gate1 || int1_pin);

        // Wie viel addieren wir? Bei C/T=1 zählen wir Flanken, sonst Maschinenzyklen
        let timer0_cycles = timer0_run ? (ct0 ? (t0_edge ? 1 : 0) : cycles) : 0;
        let timer1_cycles = timer1_run ? (ct1 ? (t1_edge ? 1 : 0) : cycles) : 0;

        let mode0 = tmod_val & 0x03;
        let mode1 = (tmod_val >> 4) & 0x03;

        // --- 4. TIMER UPDATE (Mit berechneten Cycles) ---

        // Timer 0
        if (mode0 === 3) {
            // MODE 3 Split: TL0 wird normal gesteuert
            let timer0_l = rTL0.get() + timer0_cycles;
            if (timer0_l > 0xFF) { rTCON.set(rTCON.get() | 0x20); }
            rTL0.set(timer0_l & 0xFF);
            
            // TH0 klaut sich TR1 und läuft NUR als interner Timer
            if (tr1) { 
                let timer0_h = rTH0.get() + cycles; // Ignoriert T1-Pin und C/T1
                if (timer0_h > 0xFF) { rTCON.set(rTCON.get() | 0x80); }
                rTH0.set(timer0_h & 0xFF);
            }
        } else if (timer0_cycles > 0) {
            if (mode0 === 0) { 
                let t_val = (rTH0.get() << 5) | (rTL0.get() & 0x1F);
                t_val += timer0_cycles;
                if (t_val > 0x1FFF) { t_val &= 0x1FFF; rTCON.set(rTCON.get() | 0x20); }
                rTL0.set((rTL0.get() & 0xE0) | (t_val & 0x1F));
                rTH0.set((t_val >> 5) & 0xFF);
            } else if (mode0 === 1) { 
                let t_val = (rTH0.get() << 8) | rTL0.get();
                t_val += timer0_cycles;
                if (t_val > 0xFFFF) { t_val &= 0xFFFF; rTCON.set(rTCON.get() | 0x20); }
                rTL0.set(t_val & 0xFF);
                rTH0.set((t_val >> 8) & 0xFF);
            } else if (mode0 === 2) { 
                let t_val = rTL0.get() + timer0_cycles;
                if (t_val > 0xFF) {
                    t_val = rTH0.get() + (t_val - 0x100); 
                    rTCON.set(rTCON.get() | 0x20); 
                }
                rTL0.set(t_val & 0xFF);
            }
        }

        // Timer 1 (Läuft nicht, wenn Timer 0 in Mode 3 ist und TR1 geklaut hat, oder wenn er selbst Mode 3 ist)
        if (mode1 !== 3 && mode0 !== 3 && timer1_cycles > 0) {
            if (mode1 === 0) { 
                let t_val = (rTH1.get() << 5) | (rTL1.get() & 0x1F);
                t_val += timer1_cycles;
                if (t_val > 0x1FFF) { t_val &= 0x1FFF; rTCON.set(rTCON.get() | 0x80); }
                rTL1.set((rTL1.get() & 0xE0) | (t_val & 0x1F));
                rTH1.set((t_val >> 5) & 0xFF);
            } else if (mode1 === 1) { 
                let t_val = (rTH1.get() << 8) | rTL1.get();
                t_val += timer1_cycles;
                if (t_val > 0xFFFF) { t_val &= 0xFFFF; rTCON.set(rTCON.get() | 0x80); }
                rTL1.set(t_val & 0xFF);
                rTH1.set((t_val >> 8) & 0xFF);
            } else if (mode1 === 2) { 
                let t_val = rTL1.get() + timer1_cycles;
                if (t_val > 0xFF) {
                    t_val = rTH1.get() + (t_val - 0x100); 
                    rTCON.set(rTCON.get() | 0x80); 
                }
                rTL1.set(t_val & 0xFF);
            }
        }

        // --- 5. Serielle Schnittstelle (UART TX Simulation) ---
        if (cpu.serial_tx_delay > 0) {
            cpu.serial_tx_delay -= cycles; // Ziehe die aktuellen Maschinenzyklen ab
            if (cpu.serial_tx_delay <= 0) {
                cpu.serial_tx_delay = 0;
                
                // Setze das TI-Flag (Transmit Interrupt, Bit 1 in SCON)
                let scon_val = rSCON.get();
                // Nur setzen, wenn es nicht eh schon 1 ist
                if ((scon_val & 0x02) === 0) {
                    rSCON.set(scon_val | 0x02); // 0x02 entspricht SCON.1
                }
            }
        }
    }
    
    // =========================================================
    // Interrupt Service Routine Logic (Bleibt unverändert)
    // =========================================================
    let default_irq = function(){
        let vIE = rIE.get();
        if(!(vIE & 0x80)) return -1;

        let vTCON = rTCON.get();
        let vSCON = rSCON.get();

        let IRQ =  ((vTCON & 0x02) >> 1);
        IRQ |=  ((vTCON & 0x20) >> 4);
        IRQ |=  ((vTCON & 0x08) >> 1);
        IRQ |=  ((vTCON & 0x80) >> 4);
        IRQ |=  ((((vSCON >> 1) | vSCON) & 1) << 4);

        let MAXIRQN = 5;
        let IRQMASK = (1 << MAXIRQN) - 1;

        let vIRQEM = IRQMASK & IRQ & vIE;        
        if (vIRQEM === 0) return -1;

        let vIPM = IRQMASK & rIP.get(); 

        let sel = (vIRQEM << MAXIRQN) | (vIRQEM & vIPM);
        let IRQN = 0;
        for(; IRQN < 2*MAXIRQN; ++IRQN){
            if (sel & (1 << IRQN)) break;
        }
        IRQN %= MAXIRQN;

        if(IRQN === 0) rTCON.set(rTCON.get() & 0xFD);
        else if(IRQN === 1) rTCON.set(rTCON.get() & 0xDF);
        else if(IRQN === 2) rTCON.set(rTCON.get() & 0xF7);
        else if(IRQN === 3) rTCON.set(rTCON.get() & 0x7F);
        
        return IRQN;
    }
    
    cpu.irq = default_irq;
}