// The one global import affordance: a hidden file picker plus a window-wide
// drag-and-drop overlay. Mount once near the app root. A sidebar/page button
// opens the picker by dispatching IMPORT_OPEN_EVENT, so there's a single owner
// of the ImportModal (no duplicate modals).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import Typography from '@mui/material/Typography';
import FileDownloadIcon from '@mui/icons-material/FileDownload';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';

import ImportModal from './ImportModal';

export const IMPORT_OPEN_EVENT = 'openswarm:import-open';

const ACCEPT = '.swarm,.md,.zip';

function looksImportable(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.swarm') || n.endsWith('.md') || n.endsWith('.zip');
}

const ImportEntryPoint: React.FC = () => {
  const c = useClaudeTokens();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const take = useCallback((f: File | null) => {
    if (f && looksImportable(f.name)) setPending(f);
  }, []);

  useEffect(() => {
    const openPicker = () => inputRef.current?.click();
    window.addEventListener(IMPORT_OPEN_EVENT, openPicker);
    return () => window.removeEventListener(IMPORT_OPEN_EVENT, openPicker);
  }, []);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    // Webviews are a separate compositor layer; ignore drops landing on one.
    const onWebview = (t: EventTarget | null) => (t as HTMLElement)?.tagName === 'WEBVIEW';

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e) || onWebview(e.target)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      depth.current = 0;
      setDragging(false);
      if (onWebview(e.target)) return;
      const f = e.dataTransfer?.files?.[0];
      if (f) {
        e.preventDefault();
        take(f);
      }
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [take]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => {
          take(e.target.files?.[0] || null);
          e.target.value = '';
        }}
      />
      <Fade in={dragging} timeout={{ enter: 200, exit: 220 }} unmountOnExit>
        <Box
          sx={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1.5,
            bgcolor: `${c.bg.page}e6`,
            border: `2px dashed ${c.accent.primary}`,
            pointerEvents: 'none',
          }}
        >
          <FileDownloadIcon sx={{ fontSize: 40, color: c.accent.primary }} />
          <Typography sx={{ fontSize: '1rem', fontWeight: 600, color: c.text.primary }}>
            Drop to import into OpenSwarm
          </Typography>
        </Box>
      </Fade>
      <ImportModal file={pending} open={!!pending} onClose={() => setPending(null)} />
    </>
  );
};

export default ImportEntryPoint;
