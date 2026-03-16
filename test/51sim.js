const fs =  require("fs")
// Lade die VM (Stelle sicher, dass hier execute_one und install_default_peripherals die Updates haben!)
const js51 =  require("./51vm")

let args = {
    input_file: "C:/Users/abb/Desktop/51cpu/temp/x11_ACALL_a11.hex",
    dump_file_template: "C:/Users/abb/Desktop/51cpu/temp/x11_ACALL_a11.simulate_hardware.dump.txt"
}
let cmd_arg_list = process.argv.splice(2)
if(cmd_arg_list.length > 0)
{
    args.input_file = cmd_arg_list[0]
    args.dump_file_template = cmd_arg_list[1]
}

let run_flag = true
let CPU_ERROR_ASSERT_FAILED = 0x11
let assertion_info = null

let vm = new js51.core51()
js51.install_default_peripherals(vm)

function dump_core(core) {
    let content = "";
    let ram_dump = core.IRAM
    let reg_dump = [core.SP, core.DPL, core.DPH, core.PSW, core.A, core.B]

    for (let _ of reg_dump) {
        content += `${_._value} `
    }
    content += '\n'

    let i = 0
    for (let x of ram_dump) {
        content += `${x} `
        i += 1
        if (i % 16 == 0) content += '\n'
    }
    content += ';'
    return content
}

function normal_stop(oldval, newval) {
    run_flag = false
    console.log("program exit.")
}

function assert_core(par0reg, par1reg, function_val) {
    let p0 = par0reg._value
    let p1 = par1reg._value
    if (function_val == 1){
            if (!(p0 > p1)) {
                vm.error_info.code = CPU_ERROR_ASSERT_FAILED
                assertion_info = `${p0} > ${p1} assert failed`
            }
        } else if (function_val == 2) {
            if (!(p0 == p1))
            {
                vm.error_info.code = CPU_ERROR_ASSERT_FAILED
                assertion_info = `${p0} == ${p1} assert failed`
            }
        } else if (function_val == 3) {
            if (!(p0 < p1))
            {
                vm.error_info.code = CPU_ERROR_ASSERT_FAILED
                assertion_info = `${p0} < ${p1} assert failed`
            }
        } else if (function_val == 4) {
            vm.error_info.code = CPU_ERROR_ASSERT_FAILED
            assertion_info = `user actively requestd a crash.`
        }
}

function assert_and_dump_test(core) {
    let a = Math.floor(Math.random() * 0x100)
    let b = Math.floor(Math.random() * 0x100)

    let t = [
        0x75, 0xFD, a,  // 3     MOV 0xFD, #a
        0x75, 0xFE, b,  // 4     MOV 0xFE, #b
        0x75, 0xFF,     // 5     MOV 0xFF,  ?
    ]

    let condition = [
        [1, (a, b) => a > b],
        [2, (a, b) => a == b],
        [3, (a, b) => a < b],
        [4, (a, b) => false]
    ]
    for (let cmpcode = 1; cmpcode < 4; ++cmpcode) {
        let c = [].concat(t)
        c.push(cmpcode)

        core.reset()
        core.IDATA = c
        core.next(3)
        for (let x of condition) {
            if (cmpcode == x[0])
            {
                if (vm.error_info.code == js51.CPU_NO_ERROR) {
                    if (!(x[1](a, b))) {
                        console.error("assert failed but no exception ")
                        return -1;
                    }
                } else {
                    if (x[1](a, b)) {
                        console.error("passed but exception happend " + assertion_info)
                        return -1;
                    }
                }
            }
        }
    }
    return 0;
}

// ==========================================
// NEU: Test für die Timer-Hardware-Logik
// ==========================================
function test_timer_mode2(core) {
    core.reset();
    
    // Kleines 8051 Programm in Maschinencode (Opcodes)
    let test_prog = [
        0x75, 0x89, 0x20, // MOV TMOD (0x89), #0x20  -> Timer 1, Mode 2
        0x75, 0x8D, 0xFD, // MOV TH1  (0x8D), #0xFD  -> Reload-Wert auf FD
        0x75, 0x8B, 0xFD, // MOV TL1  (0x8B), #0xFD  -> Start-Wert auf FD
        0xD2, 0x8E,       // SETB TR1 (0x8E)         -> Starte Timer 1
        0x00,             // NOP
        0x00,             // NOP
        0x00              // NOP
    ];
    
    core.IDATA = test_prog.slice();
    let rTCON = core["TCON"];
    let rTL1 = core["TL1"];
    
    // Führe die ersten 4 Befehle aus (Setup + Timer Start)
    core.next(4);
    
    // Nach dem 'SETB TR1' (Befehl 4) läuft der Timer im selben Zyklus an.
    // Startwert war 0xFD, +1 Tick = 0xFE
    if (!(rTCON.get() & 0x40)) {
        console.error("Timer-Test: TR1 wurde nicht gesetzt!");
        return -1;
    }
    if (rTL1.get() !== 0xFE) {
        console.error(`Timer-Test: TL1 sollte 0xFE sein, ist aber 0x${rTL1.get().toString(16)}`);
        return -1;
    }

    // Führe den ersten NOP aus
    core.next(1);
    // Timer tickt weiter -> 0xFF
    if (rTL1.get() !== 0xFF) {
        console.error(`Timer-Test: TL1 sollte 0xFF sein, ist aber 0x${rTL1.get().toString(16)}`);
        return -1;
    }

    // Führe den zweiten NOP aus
    core.next(1);
    // Timer überläuft! 0xFF -> 0x00, aber Auto-Reload springt ein -> 0xFD
    if (rTL1.get() !== 0xFD) {
        console.error(`Timer-Test: Auto-Reload fehlgeschlagen! TL1 ist 0x${rTL1.get().toString(16)}`);
        return -1;
    }
    
    // Prüfe, ob das Overflow-Flag (TF1) gesetzt wurde (Bit 7 in TCON)
    if (!(rTCON.get() & 0x80)) {
        console.error("Timer-Test: Overflow-Flag (TF1) wurde nicht gesetzt!");
        return -1;
    }

    return 0; // Test erfolgreich
}

let dump_content = ""

function install_my_sfr(core) {
    let p0 = "ASTPAR0"
    let p1 = "ASTPAR1"
    let my_sfr = new Map([
        [0xFB, "DUMPR"],
        [0xFC, "EXR"],
        [0xFD, p0],
        [0xFE, p1],
        [0xFF, "ASTREG"],
    ])

    let obj = core.sfr_extend(my_sfr)

    let dump_core_to_template_file = function () {
        dump_content += dump_core(core)
    }

    obj.get("DUMPR").setlistener.push((oldval, newval) => dump_core_to_template_file())
    obj.get("EXR").setlistener.push((oldval, newval) => normal_stop())
    obj.get("ASTREG").setlistener.push((oldval, newval) => assert_core(obj.get(p0), obj.get(p1), newval))
}

function main() {
    install_my_sfr(vm)
    
    // Wenn keine Datei übergeben wurde -> Test-Modus
    if(args.input_file.length == 0)
    {
        let doc = `node 51sim.js <rom_file.hex> <dump_file>`
        console.log(doc + '\n')
 
        console.log("Running Core Math Tests...")
        for (let i = 0; i < 1000; ++i)
        {
            if(assert_and_dump_test(vm) != 0)
            {
                console.error("Math test failed!")
                return;
            }
        }
        console.log("Math tests passed.");

        // NEU: Führe unseren Timer-Test aus
        console.log("Running Timer Mode 2 Auto-Reload Test...");
        if (test_timer_mode2(vm) === 0) {
            console.log("Timer test passed! Hardware tick is working.");
        } else {
            console.error("Timer test failed.");
            return;
        }

        console.log("All tests passed successfully.");
    }else{
        // Normaler Ausführungsmodus
        let data = fs.readFileSync(args.input_file,'utf-8')
        data = js51.decode_ihex(data)
        vm.IDATA = data
    
        vm.reset()
        let vPC = vm.PC._value
        while (run_flag && vm.error_info.code == js51.CPU_NO_ERROR) {
            vPC = vm.PC._value
            vm.next(1)
        }
        if(vm.error_info.code != js51.CPU_NO_ERROR)
        {
            console.error(`${vPC.toString(16)} error with code ${vm.error_info.code} ${assertion_info}` );
        }
        fs.writeFileSync(args.dump_file_template, dump_content)
    }
}

main()