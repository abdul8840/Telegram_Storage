/**
 * Full-window drag & drop target. Dropped folders keep their structure
 * (webkitGetAsEntry walk), so "Trip/Day 1/IMG_0012.HEVC.mov" lands in
 * Trip → Day 1 inside the drive.
 */
import { useEffect, useRef, useState } from 'react';
import { CloudUpload } from 'lucide-react';
import { readDroppedItems } from '../lib/dropFiles.js';

export function DropZone({ onFiles, enabled = true }) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onFiles);
  handler.current = onFiles;

  useEffect(() => {
    if (!enabled) return undefined;

    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

    const onDragEnter = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setActive(true);
    };

    const onDragOver = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (e) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setActive(false);
    };

    const onDrop = async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      const items = await readDroppedItems(e.dataTransfer);
      setActive(false);
      if (items.length) handler.current?.(items);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [enabled]);

  if (!active) return null;

  return (
    <div className="drop-overlay" role="presentation">
      <div className="drop-card">
        <CloudUpload />
        <div>
          <div className="drop-title">Drop to upload to ZoZoCloud</div>
          <p className="hint" style={{ marginTop: 8 }}>
            Files, photos and videos — including MP4, WebM, MKV and MOV. Dropped folders keep their structure.
          </p>
        </div>
      </div>
    </div>
  );
}

export default DropZone;
