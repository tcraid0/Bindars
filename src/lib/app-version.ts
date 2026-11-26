declare const __BINDARS_APP_VERSION__: string | undefined;

/** The version this build was made from. Vite copies it from package.json,
 *  which the version-consistency test keeps in step with the native app.
 *  Null when the code runs outside a Vite build, as in the workspace tests. */
export const APP_VERSION: string | null =
  typeof __BINDARS_APP_VERSION__ === "string" ? __BINDARS_APP_VERSION__ : null;
