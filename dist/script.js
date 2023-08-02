const AUDIOBUFFSIZE = 128;

class MyClass {
    constructor() {
        this.rom_name = '';
        this.iosMode = false;
        this.iosVersion = 0;
        this.audioInitialized = false;
        this.allSaveStates = [];
        this.loginModalOpened = false;
        this.canvasSize = 640;
        this.eepData = null;
        this.sraData = null;
        this.flaData = null;
        this.dblist = [];
        var Module = {};
        Module['canvas'] = document.getElementById('canvas');
        window['Module'] = Module;

        document.getElementById('file-upload').addEventListener('change', this.uploadRom.bind(this));

        this.rivetsData = {
            message: '',
            beforeEmulatorStarted: true,
            moduleInitializing: true,
            showLogin: false,
            currentFPS: 0,
            audioSkipCount: 0,
            n64SaveStates: [],
            loggedIn: false,
            noCloudSave: true,
            password: '',
            inputController: null,
            remappings: null,
            remapMode: '',
            currKey: 0,
            currJoy: 0,
            chkUseJoypad: false,
            remappingPlayer1: false,
            hasRoms: false,
            romList: [],
            inputLoopStarted: false,
            noLocalSave: true,
            lblError: '',
            chkAdvanced: false,
            eepName: '',
            sraName: '',
            flaName: '',
            swapSticks: false,
            mouseMode: false,
            useZasCMobile: false, //used for starcraft mobile
            showFPS: true,
            invert2P: false,
            invert3P: false,
            invert4P: false,
            disableAudioSync: true,
            forceAngry: false,
            remapPlayer1: true,
            remapOptions: false,
            remapGameshark: false,
            settingMobile: 'Auto',
            iosShowWarning: false,
            cheatName: '',
            cheatAddress: '',
            cheatValue: '',
            cheats: [],
            settings: {
                CLOUDSAVEURL: "",
                SHOWADVANCED: false,
                SHOWOPTIONS: false
            }
        };

        this.retrieveSettings();
    }

    setupInputController(){
        this.rivetsData.inputController = new InputController();
    
        //try to load keymappings from localstorage
        try {
            let keymappings = localStorage.getItem('n64wasm_mappings_v3');
            if (keymappings) {
                let keymappings_object = JSON.parse(keymappings);

                for (let [key, value] of Object.entries(keymappings_object)) {
                    if (key in this.rivetsData.inputController.KeyMappings){
                        this.rivetsData.inputController.KeyMappings[key] = value;
                    }
                }
            }
        } catch (error) { }
        
    }

    inputLoop(){
        myClass.rivetsData.inputController.update();
        if (myClass.rivetsData.beforeEmulatorStarted) {
            setTimeout(() => myClass.inputLoop(), 1000);
        }
    }


    processPrintStatement(text) {
        console.log(text);

        //emulator has started event
        if (text.includes('mupen64plus: Starting R4300 emulator: Cached Interpreter')) {
            console.log('detected emulator started');            
        }

        //backup sram event
        if (text.includes('writing game.savememory')){
            setTimeout(() => myClass.SaveSram(), 100);
        }
    }

    async LoadEmulator(byteArray){
        FS.writeFile('custom.v64', byteArray);
        this.WriteConfigFile();
        this.initAudio(); //need to initAudio before next call for iOS to work
        Module.callMain(['custom.v64']);
        this.configureEmulator();
        document.getElementById("canvasDiv").hidden = false;
        this.rivetsData.beforeEmulatorStarted = false;
        this.showToast = Module.cwrap('neil_toast_message', null, ['string']);
        this.toggleFPSModule = Module.cwrap('toggleFPS', null, ['number']);
        this.setRemainingAudio = Module.cwrap('neil_set_buffer_remaining', null, ['number']);

    }

    async initAudio() {
        if (!this.audioInitialized)
        {
            this.audioInitialized = true;
            this.audioContext = new AudioContext({
                latencyHint: 'interactive',
                sampleRate: 44100, //this number has to match what's in gui.cpp
            });
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = 0.5;
            this.gainNode.connect(this.audioContext.destination);
    
            //point at where the emulator is storing the audio buffer
            this.audioBufferResampled = new Int16Array(Module.HEAP16.buffer,Module._neilGetSoundBufferResampledAddress(),64000);
    
            this.audioWritePosition = 0;
            this.audioReadPosition = 0;
            this.audioBackOffCounter = 0;
            this.audioThreadLock = false;
    
    
            let url_worklet = URL.createObjectURL( new Blob([ '(', function(){

                let lastOutput = [];
                class WorkletProcessor extends AudioWorkletProcessor { 
                  constructor (options) { 
                      super(); 
                      this.port.onmessage = (event) => {
                          if(lastOutput.length < 100) {
                            lastOutput.push(event.data);
                          }
                      };
                    }
                  process(inputs, outputs) {
                    if(lastOutput.length < 20) {
                        this.port.postMessage(0);
                    }
                    
                    const newBuff = lastOutput.shift();
                    if(newBuff) {
                        outputs[0][0].set(newBuff[0]);
                        outputs[1][0].set(newBuff[1]);
                    }

                    return true; 
                  }
                }
                registerProcessor('worklet-processor', WorkletProcessor);
              
              }.toString(), ')()' ], { type: 'application/javascript' } ) );

            //emulator is synced to the OnAudioProcess event because it's way
            //more accurate than emscripten_set_main_loop or RAF
            //and the old method was having constant emulator slowdown swings
            //so the audio suffered as a result
            await this.audioContext.audioWorklet.addModule( url_worklet );
            const processor = new AudioWorkletNode( this.audioContext , 'worklet-processor', {
                outputChannelCount: [1, 1],
                numberOfInputs: 0,
                numberOfOutputs: 2
            });

            const tmpBuffer = [new Float32Array(128), new Float32Array(128)];
            processor.port.onmessage = () => {
                this.AudioProcessRecurring(tmpBuffer[0], tmpBuffer[1]);
                processor.port.postMessage(tmpBuffer);
            };
            processor.connect(this.gainNode);
        }

    }

    hasEnoughSamples(){
        let readPositionTemp = this.audioReadPosition;
        let enoughSamples = true;
        for (let sample = 0; sample < AUDIOBUFFSIZE; sample++)
        {
            if (this.audioWritePosition != readPositionTemp) {
                readPositionTemp += 2;

                //wrap back around within the ring buffer
                if (readPositionTemp == 64000) {
                    readPositionTemp = 0;
                }
            }
            else {
                enoughSamples = false;
            }
        }

        return enoughSamples;
    }

    //this method keeps getting called when it needs more audio
    //data to play so we just keep streaming it from the emulator
    AudioProcessRecurring(outputData1, outputData2){

        //I think this method is thread safe but just in case
        if (this.audioThreadLock || this.rivetsData.beforeEmulatorStarted) {
            return;
        }
        
        this.audioThreadLock = true;
        if (this.rivetsData.disableAudioSync)
        {
            this.audioWritePosition = Module._neilGetAudioWritePosition();
        }
        else
        {
            Module._runMainLoop();

            this.audioWritePosition = Module._neilGetAudioWritePosition();
    
    
            if (!this.hasEnoughSamples())
            {
                Module._runMainLoop();
            }
    
            this.audioWritePosition = Module._neilGetAudioWritePosition();
        }

        let hadSkip = false;
        //the bytes are arranged L,R,L,R,etc.... for each speaker
        for (let sample = 0; sample < AUDIOBUFFSIZE; sample++) 
        {
            if (this.audioWritePosition != this.audioReadPosition) {
                outputData1[sample] = (this.audioBufferResampled[this.audioReadPosition] / 32768);
                outputData2[sample] = (this.audioBufferResampled[this.audioReadPosition + 1] / 32768);
                this.audioReadPosition += 2;

                //wrap back around within the ring buffer
                if (this.audioReadPosition == 64000) {
                    this.audioReadPosition = 0;
                }
            } else {
                outputData1[sample] = 0;
                outputData2[sample] = 0;
                hadSkip = true;
            }
        }

        if (hadSkip)
            this.rivetsData.audioSkipCount++;

        //calculate remaining audio in buffer
        let audioBufferRemaining = 0;
        let readPositionTemp = this.audioReadPosition;
        let writePositionTemp = this.audioWritePosition;
        for(let i = 0; i < 64000; i++)
        {
            if (readPositionTemp != writePositionTemp)
            {
                readPositionTemp += 2;
                audioBufferRemaining += 2;

                if (readPositionTemp == 64000) {
                    readPositionTemp = 0;
                }
            }
        }

        this.setRemainingAudio(audioBufferRemaining);
        //myClass.showToast("Buffer: " + audioBufferRemaining);
        
        this.audioThreadLock = false;
    }

    WriteConfigFile()
    {
        let configString = "";

        //gamepad
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Up + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Down + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Left + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Right + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_A + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_B + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_Start + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_Z + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_L + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_R + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Menu + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_CLEFT + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_CRIGHT + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_CUP + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_CDOWN + "\r\n";

        //keyboard
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Left + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Right + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Up + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Down + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Start + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_CUP + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_CDOWN + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_CLEFT + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_CRIGHT + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Z + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_L + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_R + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_B + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_A + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Menu + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Analog_Up + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Analog_Down + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Analog_Left + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Analog_Right + "\r\n";

        //load save files
        if (this.eepData == null) configString += "0" + "\r\n"; else configString += "1" + "\r\n";
        if (this.sraData == null) configString += "0" + "\r\n"; else configString += "1" + "\r\n";
        if (this.flaData == null) configString += "0" + "\r\n"; else configString += "1" + "\r\n";

        //show FPS
        if (this.rivetsData.showFPS) configString += "1" + "\r\n"; else configString += "0" + "\r\n";

        //swap sticks
        if (this.rivetsData.swapSticks) configString += "1" + "\r\n"; else configString += "0" + "\r\n";

        //disable audio sync
        if (this.rivetsData.disableAudioSync) configString += "1" + "\r\n"; else configString += "0" + "\r\n";

        //invert player Y axis
        if (this.rivetsData.invert2P) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.invert3P) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.invert4P) configString += "1" + "\r\n"; else configString += "0" + "\r\n";


        //angrylion software renderer
        if (this.rivetsData.forceAngry) configString += "1" + "\r\n"; else configString += "0" + "\r\n";

        //mouse mode
        if (this.rivetsData.mouseMode) configString += "1" + "\r\n"; else configString += "0" + "\r\n";

        FS.writeFile('config.txt',configString);
    }


    uploadBrowse() {
        this.initAudio();
        document.getElementById('file-upload').click();
    }

    uploadEepBrowse() {
        document.getElementById('file-upload-eep').click();
    }
    uploadSraBrowse() {
        document.getElementById('file-upload-sra').click();
    }
    uploadFlaBrowse() {
        document.getElementById('file-upload-fla').click();
    }

    uploadEep(event) {
        var file = event.currentTarget.files[0];
        console.log(file);
        myClass.rivetsData.eepName = 'File Ready';
        var reader = new FileReader();
        reader.onprogress = function (e) {
            console.log('loaded: ' + e.loaded);
        };
        reader.onload = function (e) {
            console.log('finished loading');
            var byteArray = new Uint8Array(this.result);
            myClass.eepData = byteArray;

            FS.writeFile(
                "game.eep", // file name
                byteArray
            );
        }
        reader.readAsArrayBuffer(file);
    }
    uploadSra(event) {
        var file = event.currentTarget.files[0];
        console.log(file);
        myClass.rivetsData.sraName = 'File Ready';
        var reader = new FileReader();
        reader.onprogress = function (e) {
            console.log('loaded: ' + e.loaded);
        };
        reader.onload = function (e) {
            console.log('finished loading');
            var byteArray = new Uint8Array(this.result);
            myClass.sraData = byteArray;

            FS.writeFile(
                "game.sra", // file name
                byteArray
            );
        }
        reader.readAsArrayBuffer(file);
    }
    uploadFla(event) {
        var file = event.currentTarget.files[0];
        console.log(file);
        myClass.rivetsData.flaName = 'File Ready';
        var reader = new FileReader();
        reader.onprogress = function (e) {
            console.log('loaded: ' + e.loaded);
        };
        reader.onload = function (e) {
            console.log('finished loading');
            var byteArray = new Uint8Array(this.result);
            myClass.flaData = byteArray;

            FS.writeFile(
                "game.fla", // file name
                byteArray
            );
        }
        reader.readAsArrayBuffer(file);
    }

    uploadRom(event) {
        var file = event.currentTarget.files[0];
        myClass.rom_name = file.name;
        console.log(file);
        var reader = new FileReader();
        reader.onprogress = function (e) {
            console.log('loaded: ' + e.loaded);
        };
        reader.onload = function (e) {
            console.log('finished loading');
            var byteArray = new Uint8Array(this.result);
            myClass.LoadEmulator(byteArray);
        }
        reader.readAsArrayBuffer(file);
    }

    resizeCanvas() {
        document.getElementById("canvas").width = this.canvasSize;
    }

    zoomOut() {

        this.canvasSize -= 50;
        localStorage.setItem('n64wasm-size', this.canvasSize.toString());
        this.resizeCanvas();
    }

    zoomIn() {
        this.canvasSize += 50;
        localStorage.setItem('n64wasm-size', this.canvasSize.toString());
        this.resizeCanvas();
    }


    async initModule(){
        console.log('module initialized');
        myClass.rivetsData.moduleInitializing = false;
    }

    handleDrop(e){
        let dt = e.dataTransfer;
        let files = dt.files;

        var file = files[0];
        myClass.rom_name = file.name;
        console.log(file);
        var reader = new FileReader();
        reader.onprogress = function (e) {
            console.log('loaded: ' + e.loaded);
        };
        reader.onload = function (e) {
            console.log('finished loading');
            var byteArray = new Uint8Array(this.result);
            myClass.LoadEmulator(byteArray);
        }
        reader.readAsArrayBuffer(file);

    }

    extractRomName(name){
        if (name.includes('/'))
        {
            name = name.substr(name.lastIndexOf('/')+1);
        }

        return name;
    }

    saveStateLocal(){
        console.log('saveStateLocal');
        this.rivetsData.noLocalSave = false;
        Module._neil_serialize();
    }

    loadStateLocal(){
        console.log('loadStateLocal');
        myClass.loadFromDatabase();
    }

    SaveSram() {

        let data = FS.readFile('/game.savememory'); //this is a Uint8Array

        var request = indexedDB.open('N64WASMDB');
        request.onsuccess = function (ev) {
            var db = ev.target.result;
            var romStore = db.transaction("N64WASMSTATES", "readwrite").objectStore("N64WASMSTATES");
            var addRequest = romStore.put(data, myClass.rom_name + '.sram');
            addRequest.onsuccess = function (event) {
                console.log('sram added');
            };
            addRequest.onerror = function (event) {
                console.log('error adding sram');
                console.log(event);
            };
        }

    }

    loadFromDatabase() {

        var request = indexedDB.open('N64WASMDB');
        request.onsuccess = function (ev) {
            var db = ev.target.result;
            var romStore = db.transaction("N64WASMSTATES", "readwrite").objectStore("N64WASMSTATES");
            var rom = romStore.get(myClass.rom_name);
            rom.onsuccess = function (event) {
                let byteArray = rom.result; //Uint8Array
                FS.writeFile('/savestate.gz',byteArray);
                Module._neil_unserialize();

            };
            rom.onerror = function (event) {
                toastr.error('error getting rom from store');
            }
        }
        request.onerror = function (ev) {
            toastr.error('error loading from db')
        }

    }


    clearDatabase() {

        var request = indexedDB.deleteDatabase('N64WASMDB');
        request.onerror = function (event) {
            console.log("Error deleting database.");
            toastr.error("Error deleting database");
        };

        request.onsuccess = function (event) {
            console.log("Database deleted successfully");
            toastr.error("Database deleted successfully");
        };

    }
    

    exportEep(){
        Module._neil_export_eep();
    }
    ExportEepEvent()
    {
        console.log('js eep event');

        let filearray = FS.readFile("/game.eep");   
        var file = new File([filearray], "game.eep", {type: "text/plain; charset=x-user-defined"});
        saveAs(file);
    }
    exportSra(){
        Module._neil_export_sra();
    }
    ExportSraEvent()
    {
        console.log('js sra event');

        let filearray = FS.readFile("/game.sra");   
        var file = new File([filearray], "game.sra", {type: "text/plain; charset=x-user-defined"});
        saveAs(file);
    }
    exportFla(){
        Module._neil_export_fla();
    }
    ExportFlaEvent()
    {
        console.log('js fla event');

        let filearray = FS.readFile("/game.fla");   
        var file = new File([filearray], "game.fla", {type: "text/plain; charset=x-user-defined"});
        saveAs(file);
    }

    fullscreen() {
        try {
            const el = document.getElementById('canvas');

            if (el.webkitRequestFullScreen) {
                el.webkitRequestFullScreen();
            }
            else {
                el.mozRequestFullScreen();
            }
        } catch (error)  { 
            console.log('full screen failed');
        }
    }

    newRom(){
        location.reload();
    }

    configureEmulator(){
        let size = localStorage.getItem('n64wasm-size');
        if (size) {
            console.log('size found');
            let sizeNum = parseInt(size);
            this.canvasSize = sizeNum;
        }

        this.resizeCanvas();
    }

    setFromLocalStorage(localStorageName, rivetsName){
        if (localStorage.getItem(localStorageName))
        {
            if (localStorage.getItem(localStorageName)=="true")
                this.rivetsData[rivetsName] = true;
            else if (localStorage.getItem(localStorageName)=="false")
                this.rivetsData[rivetsName] = false;
            else
                this.rivetsData[rivetsName] = localStorage.getItem(localStorageName);
        }
    }

    setToLocalStorage(localStorageName, rivetsName){

        if (typeof(myApp.rivetsData[rivetsName]) == 'boolean')
        {
            if (this.rivetsData[rivetsName])
                localStorage.setItem(localStorageName, 'true');
            else        
                localStorage.setItem(localStorageName, 'false');
        }
        else
        {
            localStorage.setItem(localStorageName, this.rivetsData[rivetsName]);
        }

    }

    retrieveSettings(){
        //this.loadCheats();
        this.setFromLocalStorage('n64wasm-showfps','showFPS');
        this.setFromLocalStorage('n64wasm-disableaudiosyncnew','disableAudioSync');
        this.setFromLocalStorage('n64wasm-swapSticks','swapSticks');
        this.setFromLocalStorage('n64wasm-invert2P','invert2P');
        this.setFromLocalStorage('n64wasm-invert3P','invert3P');
        this.setFromLocalStorage('n64wasm-invert4P','invert4P');
        this.setFromLocalStorage('n64wasm-settingMobile','settingMobile');
        this.setFromLocalStorage('n64wasm-mouseMode','mouseMode');
        this.setFromLocalStorage('n64wasm-forceAngry','forceAngry');

    }

    saveOptions(){

        this.rivetsData.showFPS = this.rivetsData.showFPSTemp;
        this.rivetsData.swapSticks = this.rivetsData.swapSticksTemp;
        this.rivetsData.mouseMode = this.rivetsData.mouseModeTemp;
        this.rivetsData.invert2P = this.rivetsData.invert2PTemp;
        this.rivetsData.invert3P = this.rivetsData.invert3PTemp;
        this.rivetsData.invert4P = this.rivetsData.invert4PTemp;
        this.rivetsData.disableAudioSync = this.rivetsData.disableAudioSyncTemp;
        this.rivetsData.settingMobile = this.rivetsData.settingMobileTemp;
        this.rivetsData.forceAngry = this.rivetsData.forceAngryTemp;

        this.setToLocalStorage('n64wasm-showfps','showFPS');
        this.setToLocalStorage('n64wasm-disableaudiosyncnew','disableAudioSync');
        this.setToLocalStorage('n64wasm-swapSticks','swapSticks');
        this.setToLocalStorage('n64wasm-mouseMode','mouseMode');
        this.setToLocalStorage('n64wasm-invert2P','invert2P');
        this.setToLocalStorage('n64wasm-invert3P','invert3P');
        this.setToLocalStorage('n64wasm-invert4P','invert4P');
        this.setToLocalStorage('n64wasm-settingMobile','settingMobile');
        this.setToLocalStorage('n64wasm-forceAngry','forceAngry');
        
    }

    reset(){ Module._neil_reset(); }    
    
}

let myClass = new MyClass();
window["myApp"] = myClass; //so that I can reference from EM_ASM

//add any post loading logic to the window object
if (window.postLoad)
{
    window.postLoad();
}

window["Module"] = {
    onRuntimeInitialized: myClass.initModule,
    canvas: document.getElementById('canvas'),
    print: (text) => myClass.processPrintStatement(text),
}

var rando2 = Math.floor(Math.random() * 100000);
var script2 = document.createElement('script');
script2.src = 'input_controller.js?v=' + rando2;
document.getElementsByTagName('head')[0].appendChild(script2);

