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

// NEU: Timer SFRs registrieren
function get_timers() {
    return new Map([
        [0x89, "TMOD"],
        [0x8A, "TL0"],
        [0x8C, "TH0"],
        [0x8B, "TL1"],
        [0x8D, "TH1"]
    ])
}

/**
 * install serial interrupt, ports and timers from _51cpu object.
 * Add interrupt callback to cpu, support 5 interrupts
 * IE[4:0], IP[4:0], TCON[0],TCON[2], SCON[0], SCON[1]
 * @param {_51cpu} cpu
 * 
 * @returns {Map<String,reg>}
 * 
 * F8   |       |	    |       |	    |	    |	    |      |       |
 * F0   |(B)    |	    |       |	    |	    |	    |      |       |
 * E8   |       |	    |       |	    |	    |	    |      |       |
 * E0   |(ACC)  |	    |       |	    |	    |	    |      |       |
 * D8   |       |	    |       |	    |	    |	    |      |       |
 * D0   |(PSW)  |	    |       |	    |	    |	    |      |       |
 * C8   |       |	    |       |	    |	    |	    |      |       |
 * C0   |	    |	    |       |	    |	    |	    |      |       |
 * B8   |IP(P)  |	    |       |	    |	    |	    |      |       |
 * B0   |P3	    |	    |       |	    |	    |	    |      |       |
 * A8   |IE(P)  |	    |       |	    |	    |	    |      |       |
 * A0   |P2	    |	    |       |	    |	    |	    |      |       |
 * 98   |SCON(P)|SBUF   |       |	    |	    |	    |      |       |
 * 90   |P1	    |	    |       |	    |	    |	    |      |       |
 * 88   |TCON(P)|x TMOD |x TL0  |x TL0  |x TH0  |x TH1  |      |       |
 * 80   |P0	    |(SP)   |(DPL)  |(DPH)  |	    |	    |      |x PCON |
 */

function install_default_peripherals(cpu){
    let ret = new Map([
        ...cpu.sfr_extend(get_serial()),
        ...cpu.sfr_extend(get_interrupt()),
        ...cpu.sfr_extend(get_ports()),
        ...cpu.sfr_extend(get_timers()) // <-- NEU
    ])

    // Referenzen für schnellen Zugriff in hardware_tick und irq anlegen
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
    // NEU: Hardware Tick für die Timer (Modus 1 & 2)
    // =========================================================
    cpu.hardware_tick = function(cycles = 1) {
        let tcon_val = rTCON.get();
        let tmod_val = rTMOD.get();

        // --- TIMER 0 LOGIK ---
        let tr0 = (tcon_val & 0x10) !== 0; // TCON.4 (TR0 - Run Control)
        if (tr0) {
            let mode0 = tmod_val & 0x03; // TMOD untere 2 Bit (M1, M0)
            
            if (mode0 === 1) { 
                // Mode 1: 16-bit Timer
                let timer0_val = (rTH0.get() << 8) | rTL0.get();
                timer0_val += cycles;
                if (timer0_val > 0xFFFF) {
                    timer0_val &= 0xFFFF; // Overflow
                    rTCON.set(rTCON.get() | 0x20); // TF0 Flag setzen (TCON.5)
                }
                rTL0.set(timer0_val & 0xFF);
                rTH0.set((timer0_val >> 8) & 0xFF);

            } else if (mode0 === 2) { 
                // Mode 2: 8-bit Auto-Reload
                let timer0_val = rTL0.get() + cycles;
                if (timer0_val > 0xFF) {
                    // Overflow! Lade den Wert aus TH0 neu.
                    timer0_val = rTH0.get() + (timer0_val - 0x100); 
                    rTCON.set(rTCON.get() | 0x20); // TF0 Flag setzen
                }
                rTL0.set(timer0_val & 0xFF);
            }
        }

        // --- TIMER 1 LOGIK ---
        let tr1 = (tcon_val & 0x40) !== 0; // TCON.6 (TR1 - Run Control)
        if (tr1) {
            let mode1 = (tmod_val >> 4) & 0x03; // TMOD Bit 5 und 4
            
            if (mode1 === 1) { 
                // Mode 1: 16-bit Timer
                let timer1_val = (rTH1.get() << 8) | rTL1.get();
                timer1_val += cycles;
                if (timer1_val > 0xFFFF) {
                    timer1_val &= 0xFFFF; // Overflow
                    rTCON.set(rTCON.get() | 0x80); // TF1 Flag setzen (TCON.7)
                }
                rTL1.set(timer1_val & 0xFF);
                rTH1.set((timer1_val >> 8) & 0xFF);

            } else if (mode1 === 2) { 
                // Mode 2: 8-bit Auto-Reload
                let timer1_val = rTL1.get() + cycles;
                if (timer1_val > 0xFF) {
                    // Overflow! Lade den Wert aus TH1 neu.
                    timer1_val = rTH1.get() + (timer1_val - 0x100); 
                    rTCON.set(rTCON.get() | 0x80); // TF1 Flag setzen
                }
                rTL1.set(timer1_val & 0xFF);
            }
        }
    }
    
    // =========================================================
    // Interrupt Service Routine Logic
    // =========================================================
    let default_irq = function(){
        let vIE = rIE.get();
        if(!(vIE & 0x80)) // EA (Enable All) Flag checken
            return -1;

        let vTCON = rTCON.get();
        let vSCON = rSCON.get();

        let IRQ =  ((vTCON & 0x02) >> 1); // IE0 external interrupt 0
        IRQ |=  ((vTCON & 0x20) >> 4);    // TF0 Timer 0 overflow
        IRQ |=  ((vTCON & 0x08) >> 1);    // IE1 external interrupt 1
        IRQ |=  ((vTCON & 0x80) >> 4);    // TF1 Timer 1 overflow
        IRQ |=  ((((vSCON >> 1) | vSCON) & 1) << 4); // Serial

        let MAXIRQN = 5;
        let IRQMASK = (1 << MAXIRQN) - 1;

        let vIRQEM = IRQMASK & IRQ & vIE;        
        if (vIRQEM === 0)
            return -1;

        let vIPM = IRQMASK & rIP.get(); 

        let sel = (vIRQEM << MAXIRQN) | (vIRQEM & vIPM); // priority has high priority
        let IRQN = 0;
        for(; IRQN < 2*MAXIRQN; ++IRQN){
            if (sel & (1 << IRQN))
                break;
        }
        IRQN %= MAXIRQN;

        // hardware clear irq flag;
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