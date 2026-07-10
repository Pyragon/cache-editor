// TypeScript's bundled DOM lib doesn't include the File System Access API's
// directory picker yet. This app only uses showDirectoryPicker, so that's
// all that's declared here.
interface Window {
  showDirectoryPicker(options?: { mode?: 'read' | 'readwrite' }): Promise<FileSystemDirectoryHandle>
}
