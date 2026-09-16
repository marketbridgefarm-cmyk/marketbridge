import React, { useState } from 'react';
import { downloadProjectBackup } from '../utils/backupProject';

export default function BackupButton({ projectFiles, projectName = 'marketbridge-project' }) {
  const [isExporting, setIsExporting] = useState(false);

  const handleBackup = async () => {
    try {
      setIsExporting(true);
      await downloadProjectBackup(projectFiles, projectName);
    } catch (error) {
      console.error('Backup failed:', error);
      alert('Failed to generate project backup archive.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button 
      onClick={handleBackup} 
      disabled={isExporting}
      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md disabled:opacity-50"
    >
      {isExporting ? 'Compressing Files...' : 'Download Backup (.zip)'}
    </button>
  );
}
