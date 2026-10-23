# Apple IIgs in the browser

**Play it at [mohrt.github.io/appleiigs](https://mohrt.github.io/appleiigs/)**

An Apple IIgs emulator written from scratch in TypeScript. It boots both ROMs to their startup screen, runs ProDOS 16 and the Finder from 800K disks and hard disks, and plays 5.25" Apple II disks. It has:

- **Machines:** the IIgs with ROM 3 (1989) or ROM 01 (1987), chosen in Machine setup, with 4 MB of fast RAM.
- **CPU:** the WDC 65C816 at 2.8 MHz, slowed to the Mega II's 1 MHz for its memory and I/O, and while a 5.25" drive turns. It passes a sample of Tom Harte's SingleStepTests for every opcode, in emulation and native mode, cycle counts included.
- **Memory:** fast RAM from bank $00, the Mega II's 128K of slow RAM in banks $E0-$E1, and the ROM in the top banks. Banks $00 and $01 work as the IIe's main and auxiliary memory, with the IIe's soft switches, the language card and I/O, and their display areas are shadowed into $E0-$E1 as the shadow register says.
- **Video:** Super Hi-Res (320 and 640 dots, the line control bytes' 16 palettes, fill mode and scanline interrupts), and all the Apple II modes: 40- and 80-column text with MouseText, lo-res, hi-res, double lo-res and double hi-res, in the IIgs's RGB colours. Text and the border take the Control Panel's colours. 640-dot screens can blend neighbouring dots as a monitor does, so dithered colours (like the Finder's desktop) look like colours. Green, amber and white monitors too.
- **Disks:** two 3.5" drives (Apple's 800K drive, read and written bit by bit through the IWM), two 5.25" Disk II drives (copy-protected WOZ disks work), and a hard disk of up to 32 MB in slot 7, on a card with its own ProDOS firmware.
- **Sound:** the Ensoniq DOC's 32 oscillators playing from its 64K of sound RAM (free-run, one-shot and swap modes, with their interrupts), and the speaker.
- **Everything else:** the ADB keyboard and mouse, the clock with its battery RAM (the Control Panel's settings, kept between visits), the VBL, quarter-second, one-second and scanline interrupts, and a joystick (analogue, from a gamepad's stick, or from keys) and its two buttons.

Drop a disk image, or a `.zip` of them, onto the page to put it in a drive: `.po` and `.2mg` 800K disks, `.hdv`, `.po` and `.2mg` hard disks, and `.dsk`, `.do`, `.po`, `.nib` and `.woz` 5.25" disks.

## Keys and controllers

- **Keyboard:** keys type on the IIgs as labelled. Left Alt (Option on a Mac) is the Command (Apple) key and Right Alt is Option. Ctrl+F12 is Ctrl-Reset, and Command with it restarts the IIgs. Ctrl+Left Alt+Esc (Ctrl-Command-Esc) opens the desk accessories and the Control Panel, as does the toolbar's **Control Panel** button. Caps Lock is on to begin with, as most Apple II software wants capitals; the Caps Lock key (or the checkbox) switches it. The Cmd key stays with the browser.
- **Mouse:** click the screen and the mouse is the IIgs's; Esc lets it go.
- **Joystick:** a gamepad works without taking any keys: its left stick moves the joystick, the D-pad pushes it all the way, and the face buttons are the two buttons. Keys can be the joystick too: the numpad, the arrow keys with Space, or W A S D with F. Keys used by the joystick don't type, so set it back to No keys for typing.

## The machine

The toolbar has pause, Ctrl-Reset, Restart (off and on again), **Control Panel**, full screen, **Machine setup...**, the monitor (colour, green, amber or white) and **Blend 640 dots**. Machine setup chooses ROM 3 or ROM 01 and takes the ROMs; changing it restarts the IIgs.

Save states keep the whole IIgs, disks included, in the browser, and can be exported and imported as `.gsstate` files. A state only loads with the ROMs it was saved with; one from the other ROM switches to it.

## ROMs

No ROM or game files are included in this repository.

Apple's ROMs are still under copyright, so the site never serves them. On the first visit the page shows a setup panel in place of the screen: choose the ROM, then give its files.

| Machine | Main ROM | Characters |
|---|---|---|
| ROM 3 | 256K (`apple2gs.rom`) | the 4K character ROM (`apple2gs.chr`) |
| ROM 01 | 128K (`apple2gs_rom01.rom`, chip 342-0077-B) | the same character ROM |

The panel recognises Apple's ROMs by checksum, bank by bank, and puts right dumps whose banks are in another order. It takes a whole ROM collection or a zip of them too. The ROMs are kept in the browser's IndexedDB, with persistent storage requested, so later visits start straight away. **Machine setup...** in the toolbar changes or forgets them.

## Disks

The IIgs starts from the hard disk first, then the 5.25" drives, then the 3.5" ones. A hard disk without a boot block is skipped, so a data disk can stay in while starting from a floppy.

800K images are laid out on their tracks as Apple's 3.5" format does: Apple's GCR encoding, 12 to 8 sectors a track by speed zone, both sides. 5.25" sector images (`.dsk`, `.do`, `.po`) are laid out as DOS 3.3 formats them, `.nib` images keep their own bytes, and WOZ images their exact bits, copy protection included. Several files dropped or chosen at once give each drive a **Swap disk** menu for changing disks.

Your disk images are never changed. What software writes to a disk is kept in the browser and put back whenever that image is inserted again. **Revert** forgets it, and **Download** gives you the disk as it is now. **New blank disk** makes an empty 800K or 5.25" disk to initialize from the Finder, ProDOS or a game.

**Fast loading** runs the IIgs flat out while a drive is reading or writing, and the sound is skipped meanwhile.

## Free games

`npm run fetch:games` downloads the freely licensed Apple II games listed in `scripts/games-catalog.json` into `public/games/`, where they appear in a "Free games" picker. Each entry has its credit, licence, source and checksum. They're 5.25" disks, which the IIgs runs as an enhanced IIe would: A2Bejwld, Apple2048, Deflection, Escape, Flapple Bird, Froggo, Fujirun, Kaverns of KFest, Light Cycles 3D, Million Perfect Letters, Moria8, Painter, Tom Bombem and Totally. To offer other games, list them in `public/games/index.json` the same way: `{ "games": [{ "title": "Some Game", "file": "some-game.dsk" }] }`.

## Not covered

ROM 00, more or less than 4 MB of RAM, the Ensoniq's sync and amplitude-modulation modes, 400K and 1.44 MB 3.5" disks, DiskCopy and ShrinkIt images, the serial ports and AppleTalk (the serial chip only answers that nothing is plugged in), ADB devices other than the keyboard and mouse, cards other than the hard disk, and the Mega II's own mouse registers.

## Development

```sh
npm install
npm run fetch:games      # optional: free games into public/games/
npm run dev              # http://localhost:5173
npm test                 # tests needing downloaded files or your ROMs skip when they're missing
npm run fetch:cpu-tests  # optional: a sample of the 65816 SingleStepTests
```

The tests that boot the IIgs use your own ROMs, put in `roms/` (never committed) as `apple2gs_rom3.rom`, `apple2gs_rom01.rom` and `apple2gs.chr`. They boot both ROMs to "Check startup device!", and boot test disks in the 3.5" drive and on the hard disk that read and write blocks through the firmware. `DEBUG_BOOT=1 npx vitest run tests/debug-boot.test.ts` boots a ROM (`ROM=rom01` for ROM 01) for `SECONDS` seconds, prints the text screen and saves the picture to `PNG`; `DISK` and `DISK35` put a 5.25" or 800K image in drive 1.

## Deploying

`.github/workflows/pages.yml` downloads the free games and the CPU tests, tests and builds the site, and deploys it to GitHub Pages on every push to `main` (Pages source: "GitHub Actions").
