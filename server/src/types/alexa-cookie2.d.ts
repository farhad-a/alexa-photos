/**
 * Hand-written types for `alexa-cookie2`, which ships none.
 *
 * The package is CommonJS and ends with `module.exports = AlexaCookie()`, a
 * runtime-constructed object. Node's CommonJS lexer cannot detect named
 * exports from that, so a named import compiles cleanly and then throws at
 * runtime. Import the default export only:
 *
 *     import alexaCookie from "alexa-cookie2";
 *
 * Field names below were confirmed against a real registration response.
 * Everything on the result is optional: the library omits fields on several
 * of its internal paths.
 */
declare module "alexa-cookie2" {
  export interface AlexaCookieConfig {
    /** Receives the library's own log lines. It logs token material, so redact. */
    logger?: (message: string) => void;

    /** Marketplace. Defaults to `amazon.de`, so always set it explicitly. */
    amazonPage?: string;
    baseAmazonPage?: string;
    acceptLanguage?: string;
    amazonPageProxyLanguage?: string;
    userAgent?: string;

    /** Name the registered device carries in the Amazon account device list. */
    deviceAppName?: string;

    /** Proxy sign-in. `proxyOwnIp` must be an IP literal, never a hostname. */
    proxyOnly?: boolean;
    setupProxy?: boolean;
    proxyOwnIp?: string;
    proxyPort?: number;
    proxyListenBind?: string;
    proxyLogLevel?: string;
    proxyCloseWindowHTML?: string;

    /** Prior result, replayed so Amazon reuses the device instead of adding one. */
    formerRegistrationData?: AlexaRegistrationResult;
    formerDataStorePath?: string;
  }

  export interface AlexaRegistrationResult {
    /** Durable `Atnr|` refresh token. The credential worth protecting. */
    refreshToken?: string;
    accessToken?: string;

    /** Raw `Cookie:` header strings, not maps. */
    localCookie?: string;
    loginCookie?: string;

    deviceSerial?: string;
    deviceAppName?: string;
    deviceId?: string;
    amazonPage?: string;
    tokenDate?: number;
    dataVersion?: number;

    /** Device-context blobs. Must be replayed verbatim on refresh. */
    frc?: string;
    "map-md"?: string;
    macDms?: unknown;

    /** Alexa-only, unused here. Absent when the library's CSRF probe fails. */
    csrf?: string;
  }

  export type AlexaCookieCallback = (
    err: Error | null,
    result?: AlexaRegistrationResult,
  ) => void;

  interface AlexaCookie {
    /**
     * Callback fires MORE THAN ONCE on the proxy path: first a progress notice
     * delivered through `err`, then the real result after sign-in completes.
     */
    generateAlexaCookie(
      email: string | undefined,
      password: string | undefined,
      config: AlexaCookieConfig,
      callback: AlexaCookieCallback,
    ): void;

    refreshAlexaCookie(
      config: AlexaCookieConfig,
      callback: AlexaCookieCallback,
    ): void;

    getDeviceAppName(): string;
    stopProxyServer(callback?: () => void): void;
  }

  const alexaCookie: AlexaCookie;
  export default alexaCookie;
}
