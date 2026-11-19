declare module '*.css';

interface ImportMetaEnv {
  readonly BOB_WEB_RELEASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
