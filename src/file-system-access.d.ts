// TypeScript's bundled DOM lib doesn't include the File System Access API's
// directory picker yet. This app only uses showDirectoryPicker, so that's
// all that's declared here.
//
// Optional, because it genuinely is: the API is Chromium-only (Chrome, Edge,
// Brave, Opera — on any desktop OS, Linux included). Firefox and Safari don't
// implement it at all, so the call has to be feature-detected rather than assumed.
interface Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}
