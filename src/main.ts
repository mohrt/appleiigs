import { trackGameLoaded } from './analytics';
import { AudioOutput } from './audio/audio-output';
import { Disk35 } from './disk/disk35';
import { FloppyDisk } from './disk/floppy';
import { STATE_EXTENSION, filesFrom, firstDisk, readMedia, titleFromFileName } from './disk/load';
import { HardDisk } from './disk/hard-disk';
import { driveKindOf, is35, isHardDisk, type AnyDisk, type DriveKind } from './disk/media';
import { Emulator } from './emulator';
import { fetchGame, loadGameManifest, runsOn, type BundledGame } from './games';
import { CLOCK_HZ, HARD_DISK_SLOT } from './iigs';
import { Modifier } from './io/adb';
import { GamepadManager, padName, readGamepad } from './io/gamepad-input';
import { Joystick } from './io/joystick';
import { AppleKeyboard, type KeySetName } from './io/keyboard';
import { AdbMouse } from './io/mouse';
import { SCREEN_ASPECT, Screen } from './render/screen';
import {
  SystemRomStore,
  hasRequiredRoms,
  machineRoms,
  modelName,
  romsCrc,
  type Model,
  type StoredRom,
  type SystemRoms,
} from './roms/system-roms';
import { DiskSaves, type DiskSaveRecord, type SaveDiskRecord } from './storage/disk-saves';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session, type SessionDisk } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { DiskPanel } from './ui/disk-panel';
import { downloadFile } from './ui/download';
import { askForMachine } from './ui/rom-setup';
import { JsonRecord, Settings } from './ui/settings';
import { attachToolbar } from './ui/toolbar';
import type { Monitor } from './video/video';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = ['monitor', 'blend-640', 'joystick-keys', 'joystick-pad', 'caps-lock', 'warp', 'sound', 'volume'];

/** How often games' saves to their disks (and the Control Panel's settings) are written to browser storage. */
const SAVE_INTERVAL_MS = 2000;
/** Drives 0 and 1 are the 3.5" drives in slot 5, 2 and 3 the 5.25" drives in slot 6, and 4 the hard disk in slot 7. */
const DRIVES = 5;
const FIRST_525_DRIVE = 2;
const HARD_DISK_DRIVE = 4;
/** A hard disk is saved once it has been left alone this long (it can be 32 MB). */
const HARD_DISK_QUIET_CYCLES = 2 * CLOCK_HZ;
/** The battery RAM (the Control Panel's settings), kept between visits. */
const BRAM_KEY = 'appleiigs-bram';
/** The free games are 5.25" Apple II disks, which the IIgs runs as an enhanced IIe would. */
const GAME_MACHINE = 'enhanced-iie';

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'apple-iigs';

/** A line about a disk: what kind of image it is. */
function describeDisk(disk: AnyDisk): string {
  if (isHardDisk(disk)) {
    const size = (disk.data.length / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
    return `${size} MB hard disk image in slot ${HARD_DISK_SLOT}${disk.writeProtected ? ', write-protected' : ''}`;
  }
  const kind = is35(disk)
    ? '800K disk image'
    : {
        dos: 'DOS-order disk image',
        prodos: 'ProDOS-order disk image',
        nib: 'nibble image',
        woz: 'WOZ image (copy protection included)',
      }[disk.format];
  return disk.writeProtected ? `${kind}, write-protected` : kind;
}

function loadBram(target: Uint8Array): void {
  try {
    const saved = localStorage.getItem(BRAM_KEY);
    if (saved) target.set(Uint8Array.from(atob(saved), (char) => char.charCodeAt(0)).subarray(0, target.length));
  } catch {
    // Without storage the IIgs starts with the Control Panel's defaults.
  }
}

function saveBram(bram: Uint8Array): void {
  try {
    localStorage.setItem(BRAM_KEY, btoa(String.fromCharCode(...bram)));
  } catch {
    // Storage is full or blocked: the settings last until the page closes.
  }
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');
  const romSetup = requireElement<HTMLElement>('#rom-setup');
  document.documentElement.style.setProperty('--screen-aspect', SCREEN_ASPECT.toFixed(4));

  try {
    const settings = new Settings();
    settings.bind(document, REMEMBERED_SETTINGS);

    // --- ROMs ------------------------------------------------------------------------
    let storageWorks = true;
    const stores = await openBrowserStores(() => {
      status.textContent = "Waiting for the browser's storage: if this IIgs is open in another tab, close or reload that tab.";
    }).catch((error: unknown) => {
      console.warn('Browser storage is unavailable; saves will last until the page is closed.', error);
      storageWorks = false;
      return memoryStores();
    });
    if (!storageWorks) {
      requireElement<HTMLElement>('.rom-storage-note').textContent =
        "This browser isn't letting the page store files, so the ROMs will be forgotten when you close it.";
    }
    const romStore = new SystemRomStore(stores.systemRoms as KeyValueStore<StoredRom>);
    const machineRecord = new JsonRecord<{ model: Model }>('appleiigs-machine');
    let model: Model = machineRecord.read().model ?? 'rom3';
    let systemRoms: SystemRoms = await romStore.load();
    if (!hasRequiredRoms(systemRoms, model)) {
      status.textContent = 'Load the ROMs above to switch the IIgs on.';
      const setup = await askForMachine(romSetup, romStore, systemRoms, { model });
      if (!setup) throw new Error('No ROMs.');
      ({ model, roms: systemRoms } = setup);
      machineRecord.write({ model });
    }
    let roms = machineRoms(systemRoms, model);

    // --- The machine -----------------------------------------------------------------
    const screen = new Screen(canvas);
    const emulator = new Emulator(roms, screen);
    const iigs = emulator.iigs;
    loadBram(iigs.clock.bram);
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    iigs.audio.setRates(CLOCK_HZ, audio?.sampleRate ?? 48_000);

    let paused = false;
    /** While the ROM setup is open over the running IIgs. */
    let changingRoms = false;
    const focusScreen = () => canvas.focus();

    const updateStatus = () => {
      status.textContent = [modelName(roms), '65C816', `${(iigs.ramBanks * 64) / 1024} MB`].join(' · ');
    };

    // --- Drives ----------------------------------------------------------------------
    const diskIn = (drive: number): AnyDisk | null => {
      if (drive === HARD_DISK_DRIVE) return iigs.hardDiskCard.disk;
      return drive < FIRST_525_DRIVE ? iigs.disk2.drives35[drive].disk : iigs.disk2.drives[drive - FIRST_525_DRIVE].disk;
    };
    const putDisk = (drive: number, disk: AnyDisk | null) => {
      if (drive === HARD_DISK_DRIVE) iigs.insertHardDisk(disk as HardDisk | null);
      else if (drive < FIRST_525_DRIVE) iigs.insertDisk35(drive, disk as Disk35 | null);
      else iigs.insertDisk(drive - FIRST_525_DRIVE, disk as FloppyDisk | null);
    };
    /** The drive a disk goes in: the one asked for if it takes that kind, else the first empty one of its kind. */
    const driveFor = (kind: DriveKind, wanted: number): number => {
      if (kind === 'hard') return HARD_DISK_DRIVE;
      const first = kind === 'disk35' ? 0 : FIRST_525_DRIVE;
      if (wanted >= first && wanted < first + 2) return wanted;
      return diskIn(first) && !diskIn(first + 1) ? first + 1 : first;
    };

    const powerCycle = () => {
      iigs.powerOn();
      iigs.audio.resync(iigs.cycles);
      emulator.resetTiming();
      audio?.flush();
      const anyDisk = Array.from({ length: DRIVES }, (_, drive) => diskIn(drive)).some((disk) => disk !== null);
      if (!anyDisk) diskPanel.showMessage('No disks in the drives: the IIgs waits for one. Insert a 3.5" or 5.25" disk, or press Ctrl-Reset for BASIC.', true);
    };

    const ctrlReset = (restart: boolean) => {
      if (restart) {
        powerCycle();
        return;
      }
      iigs.reset();
      audio?.flush();
      diskPanel.showMessage('');
    };

    // --- Disks and their saves -------------------------------------------------------
    const diskSaves = new DiskSaves(
      stores.diskSaves as KeyValueStore<DiskSaveRecord>,
      stores.saveDisks as KeyValueStore<SaveDiskRecord>,
    );
    /** The names shown for the disks in the drives (also used to label save states). */
    const diskLabels: (string | null)[] = new Array(DRIVES).fill(null);
    const refreshSaveDisks = async () => diskPanel.setSaveDisks(await diskSaves.listSaveDisks());

    /** Stores what has been written to a drive's disk. */
    const persistDisk = async (drive: number) => {
      const disk = diskIn(drive);
      if (!disk || !disk.dirty) return;
      await diskSaves.persist(drive, disk);
      if (diskSaves.origin(drive)?.kind === 'image') diskPanel.setSavedChanges(drive, true);
    };
    const persistAll = () => Promise.all(Array.from({ length: DRIVES }, (_, drive) => persistDisk(drive)));
    setInterval(() => {
      saveBram(iigs.clock.bram);
      // Wait for the motor to stop, so a sector being written is finished; and for the hard disk to rest.
      if (iigs.disk2.spinning(iigs.cycles)) return;
      const hardDiskBusy = iigs.cycles - iigs.hardDiskUsedAt < HARD_DISK_QUIET_CYCLES;
      const drives = Array.from({ length: DRIVES }, (_, drive) => drive).filter((drive) => drive !== HARD_DISK_DRIVE || !hardDiskBusy);
      void Promise.all(drives.map((drive) => persistDisk(drive))).catch((error: unknown) => console.warn('Could not keep the disk:', error));
    }, SAVE_INTERVAL_MS);
    const saveEverything = () => {
      saveBram(iigs.clock.bram);
      void persistAll();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') saveEverything();
    });
    window.addEventListener('pagehide', saveEverything);

    const showDisk = (drive: number, disk: AnyDisk, label: string, hasSavedChanges: boolean) => {
      putDisk(drive, disk);
      diskLabels[drive] = label;
      diskPanel.showDisk(drive, label, describeDisk(disk), hasSavedChanges);
      diskPanel.showMessage('');
    };

    const eject = (drive: number) => {
      void persistDisk(drive).then(() => {
        diskSaves.eject(drive);
        putDisk(drive, null);
        diskLabels[drive] = null;
        diskPanel.showEmpty(drive);
      });
    };

    // --- Save states -----------------------------------------------------------------
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);
    const sessionName = () => diskLabels.find((label) => label !== null) ?? modelName(roms);
    const sessionDisk = (drive: number): SessionDisk | null => {
      const disk = diskIn(drive);
      if (!disk) return null;
      const name = diskLabels[drive] ?? disk.name;
      const origin = diskSaves.origin(drive);
      if (is35(disk)) return { kind: 'disk35', name, image: disk.toImage(), origin };
      if (isHardDisk(disk)) return { kind: 'hard', name, image: disk.toImage(), origin };
      return { kind: 'floppy', name, format: disk.format, woz: disk.toWoz(), origin };
    };
    const currentSession = async (): Promise<Session> => {
      await persistAll();
      return {
        machine: iigs.saveState(),
        modelName: modelName(roms),
        romsCrc: romsCrc(roms),
        disks: Array.from({ length: DRIVES }, (_, drive) => sessionDisk(drive)),
      };
    };
    const restoreSession = async (session: Session) => {
      // A state from the other ROM switches to it, if its ROMs are here.
      if (session.romsCrc !== romsCrc(roms)) {
        const stored = await romStore.load();
        const other: Model = model === 'rom3' ? 'rom01' : 'rom3';
        const otherRoms = hasRequiredRoms(stored, other) ? machineRoms(stored, other) : null;
        if (!otherRoms || session.romsCrc !== romsCrc(otherRoms)) {
          throw new Error(`That state was saved on an ${session.modelName} with other ROMs; load those (Machine setup...) to use it.`);
        }
        switchMachine(other, otherRoms);
      }
      await persistAll();
      session.disks.forEach((saved, drive) => {
        let disk: AnyDisk | null = null;
        if (saved?.kind === 'disk35') disk = Disk35.fromImage(saved.name, saved.image);
        else if (saved?.kind === 'hard') disk = HardDisk.fromImage(saved.name, saved.image);
        else if (saved?.kind === 'floppy') disk = FloppyDisk.restore(saved.name, saved.format, saved.woz);
        putDisk(drive, disk);
        diskSaves.adopt(drive, saved?.origin ?? null);
        diskLabels[drive] = saved?.name ?? null;
        if (disk && saved) diskPanel.showDisk(drive, saved.name, describeDisk(disk), false);
        else diskPanel.showEmpty(drive);
      });
      iigs.loadState(session.machine);
      emulator.resetTiming();
      audio?.flush();
      updateStatus();
    };

    // --- Panels ----------------------------------------------------------------------
    let bundledGames: BundledGame[] = [];

    /** Becomes the IIgs with the other ROM (or the same one with other ROMs), switched off and on. */
    const switchMachine = (newModel: Model, newRoms: typeof roms) => {
      model = newModel;
      roms = newRoms;
      machineRecord.write({ model });
      iigs.setRoms(roms);
      updateStatus();
    };

    /**
     * Puts one disk image in a drive (or the first of its kind for -1), or loads a save state.
     * Disk swaps aren't counted as new games.
     */
    const openDisk = async (file: File, wanted: number, newGame = false) => {
      const media = await readMedia(file);
      if (media.kind === 'state') {
        await restoreSession(await decodeSession(media.bytes));
        toolbar.showMessage('Save state loaded');
        return;
      }
      const drive = driveFor(driveKindOf(media.data.length), wanted);
      await persistDisk(drive);
      const { disk, hasSavedChanges } = await diskSaves.openImage(drive, media.name, media.data);
      const game = bundledGames.find((entry) => entry.file.split('/').pop() === file.name);
      showDisk(drive, disk, game?.title ?? titleFromFileName(file.name), hasSavedChanges);
      diskPanel.markSetDisk(drive, file.name);
      if (newGame) trackGameLoaded('appleiigs', game?.title);
    };

    /** Files dropped or chosen together: every disk in them gets a place in the Swap menus, and the first goes in. */
    const openFiles = async (chosen: File[], drive: number) => {
      const files = (await Promise.all(chosen.map((file) => filesFrom(file)))).flat();
      if (chosen.length > 1) files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const first = firstDisk(files);
      diskPanel.setZipFiles(files.length > 1 ? files : []);
      await openDisk(first, drive, true);
    };

    const diskPanel = new DiskPanel(requireElement('#disk-panel'), {
      onFiles: openFiles,
      onSwapDisk: openDisk,
      onEject: eject,
      onRevert: async (drive) => {
        const disk = await diskSaves.revert(drive);
        if (!disk) return;
        putDisk(drive, disk);
        diskPanel.setSavedChanges(drive, false);
      },
      onDownload: async (drive) => {
        const disk = diskIn(drive);
        if (!disk) return;
        if (!disk.savesCompletely) diskPanel.showMessage("Some tracks of this disk aren't in the standard format; the download only has the ones that are.", true);
        downloadFile(disk.toImage(), `${slug(diskLabels[drive] ?? disk.name)}${disk.extension}`);
      },
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onPlayGame: async (file) => {
        // Only the game's disk: the IIgs would start from a disk in an earlier slot otherwise.
        for (let drive = 0; drive < DRIVES; drive++) if (diskIn(drive)) eject(drive);
        await openFiles([file], -1);
        powerCycle();
      },
      onNewSaveDisk: async (drive) => {
        await persistDisk(drive);
        const { disk, name } = await diskSaves.createSaveDisk(drive, drive < FIRST_525_DRIVE || drive === HARD_DISK_DRIVE);
        putDisk(drive, disk);
        diskLabels[drive] = name;
        diskPanel.showDisk(drive, name, 'blank disk: initialize it from the Finder, ProDOS or the game', false);
        await refreshSaveDisks();
      },
      onInsertSaveDisk: async (id, wanted) => {
        const drive = driveFor((await diskSaves.isLargeSaveDisk(id)) ? 'disk35' : 'floppy', wanted);
        await persistDisk(drive);
        const opened = await diskSaves.openSaveDisk(drive, id);
        if (!opened) throw new Error('That save disk no longer exists.');
        showDisk(drive, opened.disk, opened.name, false);
      },
      onExportSaveDisk: async (id) => {
        await persistAll();
        const bytes = await diskSaves.saveDiskBytes(id);
        const name = (await diskSaves.listSaveDisks()).find((disk) => disk.id === id)?.name ?? 'save disk';
        if (bytes) downloadFile(bytes, `${slug(name)}${Disk35.isDiskSize(bytes.length) ? '.po' : '.dsk'}`);
      },
      onDeleteSaveDisk: async (id) => {
        for (let drive = 0; drive < DRIVES; drive++) {
          const origin = diskSaves.origin(drive);
          if (origin?.kind === 'saveDisk' && origin.id === id) {
            putDisk(drive, null);
            diskLabels[drive] = null;
            diskPanel.showEmpty(drive);
          }
        }
        await diskSaves.deleteSaveDisk(id);
        await refreshSaveDisks();
      },
      onWarp: (enabled) => (emulator.warpWhileLoading = enabled),
      focusScreen,
    });

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        emulator.resetTiming();
        audio?.flush();
      },
      onReset: () => ctrlReset(false),
      onPowerCycle: powerCycle,
      onFullscreen: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void screenFrame.requestFullscreen().then(focusScreen);
      },
      onSaveState: async () => {
        await saveStates.add(sessionName(), await currentSession());
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        downloadFile(await encodeSession(await currentSession()), `${slug(sessionName())}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();
    await refreshSaveDisks();

    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games.filter((game) => runsOn(game, GAME_MACHINE));
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      diskPanel.setGames(bundledGames.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    /** Shows Machine setup over the paused IIgs; the ROM and ROMs chosen take effect with a restart. */
    requireElement<HTMLButtonElement>('[data-action="machine-setup"]').addEventListener('click', () => {
      if (changingRoms) return;
      changingRoms = true;
      audio?.flush();
      void romStore
        .load()
        .then((stored) => askForMachine(romSetup, romStore, stored, { model, whileRunning: true }))
        .then(async (setup) => {
          changingRoms = false;
          if (setup && hasRequiredRoms(setup.roms, setup.model)) {
            await persistAll();
            switchMachine(setup.model, machineRoms(setup.roms, setup.model));
            powerCycle();
          }
          focusScreen();
        });
    });

    /** Ctrl-Command-Esc: the IIgs's desk accessory menu, with the Control Panel. */
    requireElement<HTMLButtonElement>('[data-action="control-panel"]').addEventListener('click', () => {
      iigs.adb.pressKey(0x1b, Modifier.Control | Modifier.Command);
      focusScreen();
    });

    // --- Display and sound -----------------------------------------------------------
    const monitor = requireElement<HTMLSelectElement>('select[name="monitor"]');
    const applyMonitor = () => (iigs.video.monitor = monitor.value as Monitor);
    monitor.addEventListener('change', () => {
      applyMonitor();
      focusScreen();
    });
    applyMonitor();

    const blend640 = requireElement<HTMLInputElement>('input[name="blend-640"]');
    const applyBlend = () => (iigs.video.blend640 = blend640.checked);
    blend640.addEventListener('change', () => {
      applyBlend();
      focusScreen();
    });
    applyBlend();

    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      audio?.setEnabled(sound.checked);
      audio?.setVolume(Number(volume.value));
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    applySound();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Inputs ----------------------------------------------------------------------
    const joystick = new Joystick();
    const keyboard = new AppleKeyboard(iigs.adb, joystick);
    keyboard.attach(window);
    keyboard.onReset = ctrlReset;
    const capsLock = requireElement<HTMLInputElement>('input[name="caps-lock"]');
    keyboard.capsLock = capsLock.checked;
    capsLock.addEventListener('change', () => {
      keyboard.capsLock = capsLock.checked;
      focusScreen();
    });
    keyboard.onCapsLock = (on) => {
      capsLock.checked = on;
      capsLock.dispatchEvent(new Event('change'));
    };

    const mouse = new AdbMouse(iigs.adb, canvas);
    mouse.attach();
    const mouseHint = requireElement<HTMLElement>('.mouse-hint');
    mouse.onCaptureChange = (captured) => {
      mouseHint.textContent = captured ? 'The mouse is the IIgs\'s: Esc gives it back.' : 'Click the screen to use the mouse.';
    };

    const joystickKeys = requireElement<HTMLSelectElement>('select[name="joystick-keys"]');
    const joystickPad = requireElement<HTMLSelectElement>('select[name="joystick-pad"]');
    const applyJoystickKeys = () => keyboard.setJoystickKeys(joystickKeys.value as KeySetName);
    joystickKeys.addEventListener('change', () => {
      applyJoystickKeys();
      focusScreen();
    });
    joystickPad.addEventListener('change', focusScreen);
    applyJoystickKeys();

    const gamepads = new GamepadManager();
    gamepads.attach(window);
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');
    let lastPadNames = '';
    const pollInputs = () => {
      const pads = gamepads.connected();
      const pad = joystickPad.value === 'off' ? undefined : pads[Number(joystickPad.value)];
      if (pad) joystick.set('gamepad', readGamepad(pad));
      else joystick.clear('gamepad');
      joystick.apply(iigs);
      const names = pads.map((pad, i) => `Gamepad ${i + 1}: ${padName(pad)}`).join(' · ');
      if (names !== lastPadNames) {
        lastPadNames = names;
        gamepadStatus.textContent = names;
      }
    };

    // --- Main loop -------------------------------------------------------------------
    const leds: boolean[] = new Array(DRIVES).fill(false);
    let last = performance.now();
    let wasWarped = false;
    const frame = (now: number) => {
      const elapsed = now - last;
      last = now;
      pollInputs();
      if (!paused && !changingRoms) {
        emulator.run(elapsed);
        // Warped sound would play many times too fast, so it is dropped.
        const samples = emulator.takeAudioSamples();
        if (emulator.warped !== wasWarped) audio?.flush();
        wasWarped = emulator.warped;
        if (!emulator.warped) audio?.play(samples);
      }
      for (let drive = 0; drive < DRIVES; drive++) {
        const on = iigs.driveActive(drive);
        if (on !== leds[drive]) {
          leds[drive] = on;
          diskPanel.setLed(drive, on);
        }
      }
      screen.present();
      requestAnimationFrame(frame);
    };

    for (let drive = 0; drive < DRIVES; drive++) diskPanel.showEmpty(drive);
    updateStatus();
    powerCycle();
    focusScreen();
    requestAnimationFrame(frame);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
