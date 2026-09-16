import JSZip from 'jszip';
import { saveAs } from 'file-saver';

/**
 * Packs array of project files into a .zip archive and triggers a download.
 */
export async function downloadProjectBackup(files, projectName = 'marketbridge-backup') {
  const zip = new JSZip();

  // Add every file to the ZIP folder structure
  files.forEach((file) => {
    zip.file(file.path, file.content);
  });

  // Generate the ZIP file as a Binary Large Object (Blob)
  const zipContent = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // Prompt user download with a timestamped filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${projectName}_${timestamp}.zip`;

  saveAs(zipContent, filename);
}
