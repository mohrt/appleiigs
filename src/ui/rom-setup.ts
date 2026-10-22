import { isZip, readZip } from '../disk/zip';
import {
  MODEL_NAMES,
  MODEL_ROMS,
  NotARom,
  ROM_FILE_SIZES,
  ROM_KINDS,
  hasRequiredRoms,
  hasRom,
  identifyRom,
  type IdentifiedRom,
  type Model,
  type RomKind,
  type SystemRomStore,
  type SystemRoms,
} from '../roms/system-roms';

/** ROM collections often hold a zip per machine, so zips are opened this many levels down. */
const MAX_ZIP_DEPTH = 2;

const isMacMetadata = (name: string) => name.split('/').pop()!.startsWith('.') || name.startsWith('__MACOSX/');

/** The files a dropped file stands for: itself, or the ROM-sized files (and zips) in a zip. */
async function expand(file: File, depth = 0): Promise<{ files: File[]; inZip: boolean }> {
  const data = new Uint8Array(await file.arrayBuffer());
  if (!isZip(data)) return { files: [file], inZip: depth > 0 };
  if (depth >= MAX_ZIP_DEPTH) return { files: [], inZip: true };
  const files: File[] = [];
  for (const entry of readZip(data)) {
    if (isMacMetadata(entry.name)) continue;
    if (!ROM_FILE_SIZES.has(entry.size) && !entry.name.toLowerCase().endsWith('.zip')) continue;
    const inner = new File([new Uint8Array(await entry.read())], entry.name.split('/').pop()!);
    files.push(...(await expand(inner, depth + 1)).files);
  }
  return { files, inZip: true };
}

export interface RomSetupOptions {
  /** The machine chosen to begin with. */
  model: Model;
  /** Opened from a running IIgs: offers Back (resolves null) and restarts rather than starts. */
  whileRunning?: boolean;
}

export interface MachineSetup {
  model: Model;
  roms: SystemRoms;
}

/**
 * Shows the machine setup panel in place of the screen until the chosen
 * model's ROMs are loaded and the user presses Start. Resolves with the model
 * and the ROMs, or null if the user went back to the running IIgs instead.
 */
export function askForMachine(
  root: HTMLElement,
  store: SystemRomStore,
  initial: SystemRoms,
  options: RomSetupOptions,
): Promise<MachineSetup | null> {
  const query = <T extends HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`ROM setup is missing ${selector}`);
    return element;
  };
  const fileInput = query<HTMLInputElement>('input[type="file"]');
  const startButton = query<HTMLButtonElement>('[data-action="start"]');
  const backButton = query<HTMLButtonElement>('[data-action="back"]');
  const forgetButton = query<HTMLButtonElement>('[data-action="forget-roms"]');
  const message = query<HTMLElement>('.rom-message');
  const machine = query<HTMLSelectElement>('select[name="machine"]');
  machine.value = options.model;
  query<HTMLElement>('h1').textContent = options.whileRunning ? 'Machine setup' : 'First, choose your IIgs and load its ROMs';
  const model = () => machine.value as Model;
  backButton.hidden = !options.whileRunning;
  message.textContent = '';
  const roms: SystemRoms = { ...initial };
  const warnings = new Map<RomKind, string>();
  const listeners = new AbortController();

  const describe = (kind: RomKind): string => {
    const rom = roms[kind];
    return rom ? `Loaded: ${rom.name}` : 'Not loaded yet';
  };

  const render = () => {
    const name = MODEL_NAMES[model()];
    startButton.textContent = options.whileRunning ? `Restart as the ${name}` : `Start the ${name}`;
    for (const kind of ROM_KINDS) {
      const row = query<HTMLElement>(`[data-rom="${kind}"]`);
      row.hidden = !MODEL_ROMS[model()].includes(kind);
      const warning = warnings.get(kind);
      row.dataset.state = hasRom(roms, kind) ? (warning ? 'warning' : 'loaded') : 'missing';
      row.querySelector<HTMLElement>('.rom-status')!.textContent = describe(kind) + (warning && hasRom(roms, kind) ? ` (${warning})` : '');
    }
    startButton.disabled = !hasRequiredRoms(roms, model());
    forgetButton.hidden = !Object.keys(roms).length;
  };

  const addFiles = async (chosen: File[]) => {
    const errors: string[] = [];
    const found: IdentifiedRom[] = [];
    for (const file of chosen) {
      try {
        const { files, inZip } = await expand(file);
        const before = found.length;
        for (const entry of files) {
          try {
            const rom = identifyRom(entry.name, new Uint8Array(await entry.arrayBuffer()));
            // In a collection, only Apple's own chips count: plenty of other files are the same sizes.
            if (inZip && rom.warning) continue;
            found.push(rom);
          } catch (error) {
            if (!(inZip && error instanceof NotARom)) errors.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (inZip && found.length === before && errors.length === 0) errors.push(`${file.name} has no Apple IIgs ROMs in it.`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    // Apple's chips win over unrecognised files of the same kind.
    found.sort((a, b) => Number(!a.warning) - Number(!b.warning));
    for (const rom of found) {
      roms[rom.kind] = rom;
      if (rom.warning) warnings.set(rom.kind, rom.warning);
      else warnings.delete(rom.kind);
      await store.save(rom.kind, rom);
    }
    message.textContent = errors.join(' ');
    render();
  };

  query<HTMLButtonElement>('[data-action="choose-roms"]').addEventListener('click', () => fileInput.click(), { signal: listeners.signal });
  machine.addEventListener('change', render, { signal: listeners.signal });
  fileInput.addEventListener(
    'change',
    () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      void addFiles(files);
    },
    { signal: listeners.signal },
  );
  forgetButton.addEventListener(
    'click',
    () => {
      for (const kind of Object.keys(roms) as RomKind[]) delete roms[kind];
      warnings.clear();
      message.textContent = '';
      void store.forget().then(render);
    },
    { signal: listeners.signal },
  );

  // Captured and stopped so the disk panel's page-wide drop handling doesn't also see ROM files.
  const dragOptions = { signal: listeners.signal, capture: true };
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  let dragDepth = 0;
  window.addEventListener(
    'dragenter',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragDepth++;
      root.classList.add('drag-over');
    },
    dragOptions,
  );
  window.addEventListener(
    'dragover',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    },
    dragOptions,
  );
  window.addEventListener(
    'dragleave',
    (event) => {
      if (!hasFiles(event)) return;
      event.stopImmediatePropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) root.classList.remove('drag-over');
    },
    dragOptions,
  );
  window.addEventListener(
    'drop',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragDepth = 0;
      root.classList.remove('drag-over');
      void addFiles([...(event.dataTransfer?.files ?? [])]);
    },
    dragOptions,
  );

  document.body.classList.add('needs-roms');
  root.hidden = false;
  render();
  root.scrollIntoView({ block: 'start' });

  return new Promise((resolve) => {
    const close = (result: MachineSetup | null) => {
      listeners.abort();
      root.hidden = true;
      document.body.classList.remove('needs-roms');
      resolve(result);
    };
    startButton.addEventListener('click', () => close({ model: model(), roms }), { signal: listeners.signal });
    backButton.addEventListener('click', () => close(null), { signal: listeners.signal });
  });
}
