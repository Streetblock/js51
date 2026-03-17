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

    // =========================================================
    // Hardware Tick für Timer (Mode 0, 1, 2 und 3)
    // =========================================================
    cpu.hardware_tick = function(cycles = 1) {
        let tcon_val = rTCON.get();
        let tmod_val = rTMOD.get();

        let tr0 = (tcon_val & 0x10) !== 0; // TCON.4 (TR0)
        let tr1 = (tcon_val & 0x40) !== 0; // TCON.6 (TR1)

        let mode0 = tmod_val & 0x03;       // Timer 0 Modus
        let mode1 = (tmod_val >> 4) & 0x03; // Timer 1 Modus

        // --- TIMER 0 LOGIK ---
        if (mode0 === 3) {
            // MODE 3: Split-Mode. TL0 und TH0 sind nun unabhängige 8-Bit-Timer.
            if (tr0) { // TL0 wird von TR0 gesteuert
                let timer0_l = rTL0.get() + cycles;
                if (timer0_l > 0xFF) {
                    rTCON.set(rTCON.get() | 0x20); // Setze TF0
                }
                rTL0.set(timer0_l & 0xFF);
            }
            if (tr1) { // TH0 KLAUT sich TR1 von Timer 1!
                let timer0_h = rTH0.get() + cycles;
                if (timer0_h > 0xFF) {
                    rTCON.set(rTCON.get() | 0x80); // Setze TF1 (geklaut von Timer 1)
                }
                rTH0.set(timer0_h & 0xFF);
            }
        } else if (tr0) {
            // MODE 0, 1, 2 für Timer 0
            if (mode0 === 0) { 
                // Mode 0: 13-bit Timer (TL0 nutzt nur 5 Bit, TH0 nutzt 8 Bit)
                let timer0_val = (rTH0.get() << 5) | (rTL0.get() & 0x1F);
                timer0_val += cycles;
                if (timer0_val > 0x1FFF) {
                    timer0_val &= 0x1FFF;
                    rTCON.set(rTCON.get() | 0x20); // Setze TF0
                }
                // Obere 3 Bit von TL0 bleiben erhalten, untere 5 Bit überschreiben
                rTL0.set((rTL0.get() & 0xE0) | (timer0_val & 0x1F));
                rTH0.set((timer0_val >> 5) & 0xFF);

            } else if (mode0 === 1) { 
                // Mode 1: 16-bit Timer
                let timer0_val = (rTH0.get() << 8) | rTL0.get();
                timer0_val += cycles;
                if (timer0_val > 0xFFFF) {
                    timer0_val &= 0xFFFF;
                    rTCON.set(rTCON.get() | 0x20); // Setze TF0
                }
                rTL0.set(timer0_val & 0xFF);
                rTH0.set((timer0_val >> 8) & 0xFF);

            } else if (mode0 === 2) { 
                // Mode 2: 8-bit Auto-Reload
                let timer0_val = rTL0.get() + cycles;
                if (timer0_val > 0xFF) {
                    timer0_val = rTH0.get() + (timer0_val - 0x100); 
                    rTCON.set(rTCON.get() | 0x20); // Setze TF0
                }
                rTL0.set(timer0_val & 0xFF);
            }
        }

        // --- TIMER 1 LOGIK ---
        // Timer 1 läuft nicht, wenn er selbst in Mode 3 ist.
        if (mode1 !== 3) {
            // Wenn Timer 0 in Mode 3 ist, wird TR1 für TH0 benutzt. 
            // Timer 1 läuft dann permanent durch (als Baudraten-Generator).
            let t1_running = (mode0 === 3) ? true : tr1;
            
            if (t1_running) {
                if (mode1 === 0) { 
                    // Mode 0: 13-bit Timer
                    let timer1_val = (rTH1.get() << 5) | (rTL1.get() & 0x1F);
                    timer1_val += cycles;
                    if (timer1_val > 0x1FFF) {
                        timer1_val &= 0x1FFF;
                        if (mode0 !== 3) rTCON.set(rTCON.get() | 0x80); // Nur TF1 setzen, wenn Timer 0 es nicht klaut
                    }
                    rTL1.set((rTL1.get() & 0xE0) | (timer1_val & 0x1F));
                    rTH1.set((timer1_val >> 5) & 0xFF);

                } else if (mode1 === 1) { 
                    // Mode 1: 16-bit Timer
                    let timer1_val = (rTH1.get() << 8) | rTL1.get();
                    timer1_val += cycles;
                    if (timer1_val > 0xFFFF) {
                        timer1_val &= 0xFFFF;
                        if (mode0 !== 3) rTCON.set(rTCON.get() | 0x80);
                    }
                    rTL1.set(timer1_val & 0xFF);
                    rTH1.set((timer1_val >> 8) & 0xFF);

                } else if (mode1 === 2) { 
                    // Mode 2: 8-bit Auto-Reload (Typisch für Baudrate)
                    let timer1_val = rTL1.get() + cycles;
                    if (timer1_val > 0xFF) {
                        timer1_val = rTH1.get() + (timer1_val - 0x100); 
                        if (mode0 !== 3) rTCON.set(rTCON.get() | 0x80);
                    }
                    rTL1.set(timer1_val & 0xFF);
                }
            }
        }
    }
    
    // =========================================================
    // Interrupt Service Routine Logic
    // =========================================================
    let default_irq = function(){
        let vIE = rIE.get();
        if(!(vIE & 0x80))
            return -1;

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
        if (vIRQEM === 0)
            return -1;

        let vIPM = IRQMASK & rIP.get(); 

        let sel = (vIRQEM << MAXIRQN) | (vIRQEM & vIPM);
        let IRQN = 0;
        for(; IRQN < 2*MAXIRQN; ++IRQN){
            if (sel & (1 << IRQN))
                break;
        }
        IRQN %= MAXIRQN;

        if(IRQN === 0){
            rTCON.set(rTCON.get() & 0xFD);
        }else if(IRQN === 1){
            rTCON.set(rTCON.get() & 0xDF);
        }else if(IRQN === 2){
            rTCON.set(rTCON.get() & 0xF7);
        }else if(IRQN === 3){
            rTCON.set(rTCON.get() & 0x7F);
        }
        return IRQN;
    }
    
    cpu.irq = default_irq;
}