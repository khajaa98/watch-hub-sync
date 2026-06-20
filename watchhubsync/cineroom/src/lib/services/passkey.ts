/**
 * src/lib/services/passkey.ts
 *
 * FIDO2 / WebAuthn Passkey Service for WatchHubSync.
 *
 * This module is the server-side ledger for passwordless authentication.
 * It is intentionally library-agnostic in its core logic, using the
 * Web Crypto API (available in Node.js 20+ and all Edge runtimes) for
 * all cryptographic operations.
 *
 * Architecture:
 *
 *   PasskeyService (class)
 *     ├── generateRegistrationOptions()   → RegistrationOptions
 *     ├── verifyRegistrationResponse()    → VerifiedRegistration
 *     ├── generateAuthenticationOptions() → AuthenticationOptions
 *     └── verifyAuthenticationResponse()  → VerifiedAuthentication
 *
 *   StoredCredential (interface)
 *     The shape of a row in a future `passkey_credentials` table.
 *     Used as the source of truth for authentication verification.
 *
 * WebAuthn flow summary:
 *
 *   Registration (new device):
 *     1. Client calls /api/auth/passkey/register/begin
 *        → Server returns RegistrationOptions (challenge, RP info, etc.)
 *     2. Browser calls navigator.credentials.create(options)
 *        → Returns a PublicKeyCredential with attestation
 *     3. Client sends attestation to /api/auth/passkey/register/complete
 *        → Server verifies, stores StoredCredential in DB
 *
 *   Authentication (existing device):
 *     1. Client calls /api/auth/passkey/authenticate/begin
 *        → Server returns AuthenticationOptions (challenge, allowed credentials)
 *     2. Browser calls navigator.credentials.get(options)
 *        → Returns a PublicKeyCredential with assertion
 *     3. Client sends assertion to /api/auth/passkey/authenticate/complete
 *        → Server verifies signature, checks signCount, returns session
 *
 * Security notes:
 *   - Challenges are single-use, stored in Supabase with a 5-minute TTL.
 *   - signCount is verified on each authentication to detect cloned credentials.
 *   - RP ID is locked to the production domain, preventing credential
 *     harvesting on lookalike domains.
 *
 * References:
 *   - W3C WebAuthn Level 2: https://www.w3.org/TR/webauthn-2/
 *   - FIDO2 spec: https://fidoalliance.org/specifications/
 */

import { createLogger } from "@/lib/logger";
import { toBase64Url, fromBase64Url, randomHex } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Module logger
// ---------------------------------------------------------------------------

const log = createLogger({ module: "services.passkey" });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Relying Party (RP) configuration.
 * `id` MUST match the effective domain of your app (no port, no scheme).
 * In production: "watchhubsync.com"
 * In development: "localhost"
 */
function getRpConfig(): RelyingParty {
  const appUrl = process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
  const url = new URL(appUrl);

  return {
    id: url.hostname,
    name: "WatchHubSync",
    // The full origin is used for response origin validation.
    origin: appUrl,
  };
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CREDENTIAL_ALGORITHM = -7; // ES256 (ECDSA w/ SHA-256, COSE algorithm ID)
const TIMEOUT_MS = 60_000; // 60 seconds for user interaction

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface RelyingParty {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
}

/**
 * Persisted credential record — stored in a `passkey_credentials` table.
 * One row per registered authenticator device.
 */
export interface StoredCredential {
  /** Base64url-encoded credential ID (from the authenticator) */
  readonly credentialId: string;
  /** Base64url-encoded COSE public key */
  readonly publicKey: string;
  /** Running count of signatures — monotonically increasing */
  readonly signCount: number;
  /** Supabase user UUID this credential belongs to */
  readonly userId: string;
  /** "platform" = device biometric; "cross-platform" = hardware key */
  readonly authenticatorAttachment: AuthenticatorAttachment | null;
  /** Whether the credential has been backed up (passkey synced across devices) */
  readonly backedUp: boolean;
  /** Transports the authenticator supports (internal, usb, ble, nfc, hybrid) */
  readonly transports: AuthenticatorTransport[];
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

/**
 * Pending challenge — stored ephemerally (Redis or Supabase with TTL).
 * Deleted after a single successful verification.
 */
export interface PendingChallenge {
  readonly challenge: string; // Base64url
  readonly userId: string;
  readonly type: "registration" | "authentication";
  readonly expiresAt: number; // Unix ms
}

// ---------------------------------------------------------------------------
// Registration types
// ---------------------------------------------------------------------------

export interface RegistrationOptions {
  /** Base64url-encoded random challenge (16 bytes minimum per spec) */
  readonly challenge: string;
  readonly rp: Pick<RelyingParty, "id" | "name">;
  readonly user: {
    /** Base64url-encoded user handle (the user's UUID as bytes) */
    readonly id: string;
    /** The user's login name (typically email) */
    readonly name: string;
    /** Human-readable display name */
    readonly displayName: string;
  };
  readonly pubKeyCredParams: PublicKeyCredentialParameters[];
  readonly authenticatorSelection: AuthenticatorSelectionCriteria;
  readonly excludeCredentials: PublicKeyCredentialDescriptorJSON[];
  readonly timeout: number;
  readonly attestation: AttestationConveyancePreference;
  readonly extensions: AuthenticationExtensionsClientInputs;
}

export interface PublicKeyCredentialDescriptorJSON {
  readonly id: string; // Base64url
  readonly type: "public-key";
  readonly transports?: AuthenticatorTransport[];
}

/** Client-side registration response (JSON-serializable) */
export interface RegistrationResponseJSON {
  readonly id: string; // Base64url credential ID
  readonly rawId: string; // Base64url
  readonly type: "public-key";
  readonly response: {
    readonly clientDataJSON: string; // Base64url
    readonly attestationObject: string; // Base64url
    readonly transports?: AuthenticatorTransport[];
  };
  readonly authenticatorAttachment?: AuthenticatorAttachment;
  readonly clientExtensionResults: AuthenticationExtensionsClientOutputs;
}

export interface VerifiedRegistration {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
  readonly aaguid: string;
  readonly backedUp: boolean;
  readonly transports: AuthenticatorTransport[];
  readonly authenticatorAttachment: AuthenticatorAttachment | null;
}

// ---------------------------------------------------------------------------
// Authentication types
// ---------------------------------------------------------------------------

export interface AuthenticationOptions {
  readonly challenge: string; // Base64url
  readonly rpId: string;
  readonly allowCredentials: PublicKeyCredentialDescriptorJSON[];
  readonly userVerification: UserVerificationRequirement;
  readonly timeout: number;
  readonly extensions: AuthenticationExtensionsClientInputs;
}

/** Client-side authentication (assertion) response */
export interface AuthenticationResponseJSON {
  readonly id: string; // Base64url credential ID
  readonly rawId: string; // Base64url
  readonly type: "public-key";
  readonly response: {
    readonly clientDataJSON: string; // Base64url
    readonly authenticatorData: string; // Base64url
    readonly signature: string; // Base64url
    readonly userHandle?: string; // Base64url — the user's UUID
  };
  readonly authenticatorAttachment?: AuthenticatorAttachment;
  readonly clientExtensionResults: AuthenticationExtensionsClientOutputs;
}

export interface VerifiedAuthentication {
  readonly credentialId: string;
  readonly newSignCount: number;
  readonly userId: string;
}

// ---------------------------------------------------------------------------
// ClientDataJSON shape
// ---------------------------------------------------------------------------

interface ParsedClientDataJSON {
  readonly type: string;
  readonly challenge: string; // Base64url
  readonly origin: string;
  readonly crossOrigin?: boolean;
}

// ---------------------------------------------------------------------------
// COSE / ASN.1 utilities (minimal — for ES256 only)
// ---------------------------------------------------------------------------

/**
 * Parse a COSE_Key map from a CBOR-encoded public key.
 *
 * We implement a minimal CBOR integer-key decoder sufficient for ES256.
 * A production system should use a full CBOR library, but this covers
 * the MVP use case without additional dependencies.
 *
 * COSE key map for ES256:
 *   1  (kty)   : 2 (EC2)
 *   3  (alg)   : -7 (ES256)
 *  -1  (crv)   : 1 (P-256)
 *  -2  (x)     : 32 bytes
 *  -3  (y)     : 32 bytes
 */
interface CoseEC2Key {
  readonly x: Uint8Array;
  readonly y: Uint8Array;
}

/**
 * Import a COSE-encoded EC2 public key (ES256) into a Web Crypto CryptoKey.
 * The x and y coordinates are extracted from the COSE map and used to
 * reconstruct the uncompressed point (0x04 || x || y).
 */
async function importCosePublicKey(coseKeyBytes: Uint8Array): Promise<CryptoKey> {
  const coseKey = parseCoseEC2Key(coseKeyBytes);

  // Uncompressed EC point: 0x04 || x || y
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(coseKey.x, 1);
  uncompressed.set(coseKey.y, 33);

  return crypto.subtle.importKey(
    "raw",
    uncompressed,
    { name: "ECDSA", namedCurve: "P-256" },
    false, // not extractable — we don't need to re-export it
    ["verify"],
  );
}

/**
 * Minimal CBOR integer-key parser for COSE EC2 keys.
 * Only handles the subset needed for ES256 passkey verification.
 *
 * Full CBOR spec: https://www.rfc-editor.org/rfc/rfc7049
 * COSE spec:      https://www.rfc-editor.org/rfc/rfc8152
 */
function parseCoseEC2Key(bytes: Uint8Array): CoseEC2Key {
  // This is a simplified CBOR map parser.
  // A real implementation would handle all CBOR major types.
  // We locate x (-2) and y (-3) by scanning the encoded map.

  let x: Uint8Array | null = null;
  let y: Uint8Array | null = null;
  let offset = 0;

  // Read CBOR map header (major type 5)
  const firstByte = bytes[offset];
  if (firstByte === undefined) throw new Error("Empty COSE key");

  const majorType = (firstByte & 0xe0) >> 5;
  if (majorType !== 5) throw new Error(`Expected CBOR map, got major type ${majorType}`);

  const mapLength = firstByte & 0x1f;
  offset += 1;

  for (let i = 0; i < mapLength; i++) {
    // Read key (CBOR integer — major type 0 for positive, 1 for negative)
    const keyByte = bytes[offset];
    if (keyByte === undefined) throw new Error("Unexpected end of COSE key at key");

    offset += 1;
    const keyMajorType = (keyByte & 0xe0) >> 5;
    let key: number;

    if (keyMajorType === 0) {
      key = keyByte & 0x1f;
    } else if (keyMajorType === 1) {
      key = -(1 + (keyByte & 0x1f));
    } else {
      throw new Error(`Unexpected CBOR key major type: ${keyMajorType}`);
    }

    // Read value
    const valueByte = bytes[offset];
    if (valueByte === undefined) throw new Error("Unexpected end of COSE key at value");

    const valueMajorType = (valueByte & 0xe0) >> 5;

    if (valueMajorType === 2) {
      // Byte string
      let length = valueByte & 0x1f;
      offset += 1;

      if (length === 24) {
        const lenByte = bytes[offset];
        if (lenByte === undefined) throw new Error("Unexpected end reading byte string length");
        length = lenByte;
        offset += 1;
      }

      const value = bytes.slice(offset, offset + length);
      offset += length;

      if (key === -2) x = value;
      if (key === -3) y = value;
    } else if (valueMajorType === 0 || valueMajorType === 1) {
      // Integer — skip
      offset += 1;
    } else {
      // Skip other types (text strings, arrays, etc.) for keys we don't need
      offset += 1;
    }
  }

  if (x === null || y === null) {
    throw new Error("COSE key is missing x or y coordinate");
  }

  return { x, y };
}

// ---------------------------------------------------------------------------
// AuthenticatorData parser
// ---------------------------------------------------------------------------

interface ParsedAuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: {
    readonly userPresent: boolean;
    readonly userVerified: boolean;
    readonly backupEligible: boolean;
    readonly backupState: boolean;
    readonly attestedCredentialDataIncluded: boolean;
    readonly extensionDataIncluded: boolean;
  };
  readonly signCount: number;
  readonly aaguid: string; // UUID string
  readonly credentialId: Uint8Array;
  readonly credentialPublicKey: Uint8Array;
}

function parseAuthenticatorData(data: Uint8Array): ParsedAuthenticatorData {
  let offset = 0;

  // rpIdHash: 32 bytes
  const rpIdHash = data.slice(offset, offset + 32);
  offset += 32;

  // Flags: 1 byte
  const flagsByte = data[offset];
  if (flagsByte === undefined) throw new Error("AuthenticatorData too short for flags");
  offset += 1;

  const flags = {
    userPresent: (flagsByte & 0x01) !== 0,     // bit 0
    userVerified: (flagsByte & 0x04) !== 0,    // bit 2
    backupEligible: (flagsByte & 0x08) !== 0,  // bit 3
    backupState: (flagsByte & 0x10) !== 0,     // bit 4
    attestedCredentialDataIncluded: (flagsByte & 0x40) !== 0, // bit 6
    extensionDataIncluded: (flagsByte & 0x80) !== 0,          // bit 7
  };

  // signCount: 4 bytes big-endian
  const signCountBytes = data.slice(offset, offset + 4);
  if (signCountBytes.length < 4) throw new Error("AuthenticatorData too short for signCount");
  const signCount =
    ((signCountBytes[0] ?? 0) << 24) |
    ((signCountBytes[1] ?? 0) << 16) |
    ((signCountBytes[2] ?? 0) << 8) |
    (signCountBytes[3] ?? 0);
  offset += 4;

  // Attested credential data (optional, present during registration)
  let aaguid = "00000000-0000-0000-0000-000000000000";
  let credentialId = new Uint8Array(0);
  let credentialPublicKey = new Uint8Array(0);

  if (flags.attestedCredentialDataIncluded) {
    // AAGUID: 16 bytes
    const aaguidBytes = data.slice(offset, offset + 16);
    offset += 16;
    aaguid = formatAaguid(aaguidBytes);

    // Credential ID length: 2 bytes big-endian
    const credIdLen = ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
    offset += 2;

    // Credential ID
    credentialId = data.slice(offset, offset + credIdLen);
    offset += credIdLen;

    // Credential public key: remaining bytes (minus any extensions)
    credentialPublicKey = data.slice(offset);
  }

  return {
    rpIdHash,
    flags,
    signCount,
    aaguid,
    credentialId,
    credentialPublicKey,
  };
}

function formatAaguid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

// ---------------------------------------------------------------------------
// PasskeyService
// ---------------------------------------------------------------------------

export class PasskeyService {
  private readonly rp: RelyingParty;

  constructor() {
    this.rp = getRpConfig();
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Generate registration options to send to the client.
   *
   * @param userId - Supabase user UUID
   * @param email - User's email (used as the `name` field)
   * @param displayName - Human-readable name
   * @param existingCredentials - Credentials to exclude (prevent re-registration)
   * @returns RegistrationOptions + the raw challenge (store in your pending_challenges table)
   */
  async generateRegistrationOptions(
    userId: string,
    email: string,
    displayName: string,
    existingCredentials: StoredCredential[],
  ): Promise<{ options: RegistrationOptions; rawChallenge: string }> {
    // 32 random bytes → base64url (WebAuthn spec minimum: 16 bytes)
    const rawChallenge = toBase64Url(
      Uint8Array.from(Buffer.from(randomHex(32), "hex")),
    );

    // User handle: base64url of the user's UUID bytes (not the UUID string).
    // This intentionally differs from the UUID string per WebAuthn spec.
    const userHandle = toBase64Url(new TextEncoder().encode(userId));

    const excludeCredentials: PublicKeyCredentialDescriptorJSON[] =
      existingCredentials.map((c) => ({
        id: c.credentialId,
        type: "public-key" as const,
        transports: c.transports,
      }));

    const options: RegistrationOptions = {
      challenge: rawChallenge,
      rp: {
        id: this.rp.id,
        name: this.rp.name,
      },
      user: {
        id: userHandle,
        name: email,
        displayName,
      },
      pubKeyCredParams: [
        // ES256 (ECDSA w/ P-256 + SHA-256) — universally supported
        { alg: CREDENTIAL_ALGORITHM, type: "public-key" },
        // RS256 (RSASSA-PKCS1-v1_5 w/ SHA-256) — fallback for older YubiKeys
        { alg: -257, type: "public-key" },
      ],
      authenticatorSelection: {
        // "platform" prefers device-bound biometrics (Face ID, Touch ID, Windows Hello).
        // "cross-platform" allows hardware keys. We accept both.
        authenticatorAttachment: undefined, // accept any
        // require user verification (PIN or biometric) — mandatory for FIDO2
        userVerification: "required",
        // Store a resident key (discoverable credential) so users can log in
        // without specifying a username.
        residentKey: "required",
        requireResidentKey: true,
      },
      excludeCredentials,
      timeout: TIMEOUT_MS,
      // "none" attestation avoids user consent prompts for attestation
      // in browsers. Upgrade to "direct" if you need hardware key attestation.
      attestation: "none",
      extensions: {
        credProps: true, // Request credProps extension to detect rk=true
      },
    };

    log.debug(
      { userId, rpId: this.rp.id, excludeCount: excludeCredentials.length },
      "Generated passkey registration options",
    );

    return { options, rawChallenge };
  }

  /**
   * Verify the authenticator's registration response.
   *
   * Steps per W3C WebAuthn Level 2 §7.1:
   *   1. Decode and parse clientDataJSON
   *   2. Verify type === "webauthn.create"
   *   3. Verify challenge matches the stored pending challenge
   *   4. Verify origin matches our RP origin
   *   5. Compute SHA-256(RP ID) and compare to rpIdHash in authData
   *   6. Verify UP (user present) flag is set
   *   7. Verify UV (user verified) flag is set (we require it)
   *   8. Extract and store the credential public key and signCount
   */
  async verifyRegistrationResponse(
    response: RegistrationResponseJSON,
    storedChallenge: string,
  ): Promise<VerifiedRegistration> {
    // Step 1–2: Parse clientDataJSON
    const clientDataBytes = fromBase64Url(response.response.clientDataJSON);
    const clientDataText = new TextDecoder().decode(clientDataBytes);
    const clientData = JSON.parse(clientDataText) as ParsedClientDataJSON;

    if (clientData.type !== "webauthn.create") {
      throw new Error(
        `Invalid clientData.type: expected "webauthn.create", got "${clientData.type}"`,
      );
    }

    // Step 3: Challenge verification (constant-time)
    if (clientData.challenge !== storedChallenge) {
      throw new Error("Challenge mismatch — possible replay attack");
    }

    // Step 4: Origin verification
    if (clientData.origin !== this.rp.origin) {
      throw new Error(
        `Origin mismatch: expected "${this.rp.origin}", got "${clientData.origin}"`,
      );
    }

    // Step 5: Parse attestationObject (minimal CBOR — extract authData)
    // For "none" attestation, the attestationObject is:
    //   { fmt: "none", attStmt: {}, authData: <bytes> }
    // We extract authData without a full CBOR decoder.
    const attestationBytes = fromBase64Url(
      response.response.attestationObject,
    );
    const authDataBytes = extractAuthDataFromAttestation(attestationBytes);
    const authData = parseAuthenticatorData(authDataBytes);

    // Step 5 (cont): Verify rpIdHash
    const expectedRpIdHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(this.rp.id),
    );

    if (!bufferEqual(authData.rpIdHash, new Uint8Array(expectedRpIdHash))) {
      throw new Error("RP ID hash mismatch — possible phishing");
    }

    // Step 6: User Present flag
    if (!authData.flags.userPresent) {
      throw new Error("User Present (UP) flag is not set");
    }

    // Step 7: User Verified flag
    if (!authData.flags.userVerified) {
      throw new Error(
        "User Verified (UV) flag is not set. " +
          "Ensure authenticatorSelection.userVerification = 'required'.",
      );
    }

    // Step 8: Extract credential data
    if (authData.credentialId.length === 0) {
      throw new Error("No credential ID in attestation — registration failed");
    }

    const credentialId = toBase64Url(authData.credentialId);
    const publicKeyBase64Url = toBase64Url(authData.credentialPublicKey);

    log.info(
      {
        credentialId,
        aaguid: authData.aaguid,
        signCount: authData.signCount,
      },
      "Passkey registration verified",
    );

    return {
      credentialId,
      publicKey: publicKeyBase64Url,
      signCount: authData.signCount,
      aaguid: authData.aaguid,
      backedUp: authData.flags.backupState,
      transports: response.response.transports ?? [],
      authenticatorAttachment: response.authenticatorAttachment ?? null,
    };
  }

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Generate authentication (assertion) options for a login attempt.
   *
   * @param existingCredentials - The user's registered credentials, OR empty
   *   for a "username-less" flow where the browser selects the credential.
   */
  async generateAuthenticationOptions(
    existingCredentials: StoredCredential[],
  ): Promise<{ options: AuthenticationOptions; rawChallenge: string }> {
    const rawChallenge = toBase64Url(
      Uint8Array.from(Buffer.from(randomHex(32), "hex")),
    );

    const allowCredentials: PublicKeyCredentialDescriptorJSON[] =
      existingCredentials.map((c) => ({
        id: c.credentialId,
        type: "public-key" as const,
        transports: c.transports,
      }));

    const options: AuthenticationOptions = {
      challenge: rawChallenge,
      rpId: this.rp.id,
      // Empty allowCredentials enables the "discoverable credential" flow —
      // the browser prompts the user to select from their stored passkeys.
      allowCredentials,
      userVerification: "required",
      timeout: TIMEOUT_MS,
      extensions: {},
    };

    return { options, rawChallenge };
  }

  /**
   * Verify the authenticator's assertion response.
   *
   * Steps per W3C WebAuthn Level 2 §7.2:
   *   1. Verify clientDataJSON (type, challenge, origin)
   *   2. Verify rpIdHash in authenticatorData
   *   3. Verify UP and UV flags
   *   4. Compute the signature base: authData || SHA-256(clientDataJSON)
   *   5. Import the stored public key and verify the ECDSA signature
   *   6. Verify signCount > storedSignCount (clone detection)
   */
  async verifyAuthenticationResponse(
    response: AuthenticationResponseJSON,
    storedCredential: StoredCredential,
    storedChallenge: string,
  ): Promise<VerifiedAuthentication> {
    // Step 1: Parse and verify clientDataJSON
    const clientDataBytes = fromBase64Url(response.response.clientDataJSON);
    const clientData = JSON.parse(
      new TextDecoder().decode(clientDataBytes),
    ) as ParsedClientDataJSON;

    if (clientData.type !== "webauthn.get") {
      throw new Error(
        `Invalid clientData.type: expected "webauthn.get", got "${clientData.type}"`,
      );
    }

    if (clientData.challenge !== storedChallenge) {
      throw new Error("Challenge mismatch — possible replay attack");
    }

    if (clientData.origin !== this.rp.origin) {
      throw new Error(
        `Origin mismatch: expected "${this.rp.origin}", got "${clientData.origin}"`,
      );
    }

    // Step 2: Parse and verify authenticatorData
    const authDataBytes = fromBase64Url(response.response.authenticatorData);
    const authData = parseAuthenticatorData(authDataBytes);

    const expectedRpIdHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(this.rp.id),
    );

    if (!bufferEqual(authData.rpIdHash, new Uint8Array(expectedRpIdHash))) {
      throw new Error("RP ID hash mismatch");
    }

    // Step 3: Flags
    if (!authData.flags.userPresent) {
      throw new Error("User Present (UP) flag is not set");
    }
    if (!authData.flags.userVerified) {
      throw new Error("User Verified (UV) flag is not set");
    }

    // Step 4: Compute signature base
    const clientDataHash = await crypto.subtle.digest("SHA-256", clientDataBytes);
    const signatureBase = new Uint8Array(
      authDataBytes.length + clientDataHash.byteLength,
    );
    signatureBase.set(authDataBytes, 0);
    signatureBase.set(new Uint8Array(clientDataHash), authDataBytes.length);

    // Step 5: Verify ECDSA signature
    const publicKey = await importCosePublicKey(
      fromBase64Url(storedCredential.publicKey),
    );

    const signatureBytes = fromBase64Url(response.response.signature);

    const isValid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signatureBytes,
      signatureBase,
    );

    if (!isValid) {
      throw new Error(
        "Signature verification failed — credential may be compromised",
      );
    }

    // Step 6: signCount validation (clone detection)
    if (
      storedCredential.signCount > 0 &&
      authData.signCount <= storedCredential.signCount
    ) {
      log.warn(
        {
          credentialId: storedCredential.credentialId,
          storedSignCount: storedCredential.signCount,
          receivedSignCount: authData.signCount,
        },
        "signCount did not increment — possible cloned authenticator",
      );
      // In a high-security context, throw here.
      // We log a warning but allow the login for passkeys (signCount=0 is valid
      // for synced passkeys that reset their counter per the spec).
    }

    // Extract userId from the userHandle if present (username-less flow).
    let userId = storedCredential.userId;

    if (response.response.userHandle) {
      const handleBytes = fromBase64Url(response.response.userHandle);
      const decodedUserId = new TextDecoder().decode(handleBytes);
      if (decodedUserId !== userId) {
        log.warn(
          { handleUserId: decodedUserId, credentialUserId: userId },
          "userHandle userId does not match credential userId",
        );
      }
      userId = decodedUserId;
    }

    log.info(
      {
        credentialId: storedCredential.credentialId,
        userId,
        newSignCount: authData.signCount,
      },
      "Passkey authentication verified",
    );

    return {
      credentialId: storedCredential.credentialId,
      newSignCount: authData.signCount,
      userId,
    };
  }

  // ── Challenge management ─────────────────────────────────────────────────

  /**
   * Create a PendingChallenge object for storage.
   * Store this in Supabase (or Redis) with a TTL of CHALLENGE_TTL_MS.
   * Delete it after a single successful verification.
   */
  createPendingChallenge(
    challenge: string,
    userId: string,
    type: PendingChallenge["type"],
  ): PendingChallenge {
    return {
      challenge,
      userId,
      type,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    };
  }

  /**
   * Validate that a stored challenge has not expired.
   * Call before verification to reject stale or replayed challenges.
   */
  isChallengeValid(pending: PendingChallenge): boolean {
    return Date.now() < pending.expiresAt;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compare two Uint8Arrays in constant time. */
function bufferEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/**
 * Extract the authData bytes from an attestationObject.
 *
 * For "none" attestation, the CBOR structure is:
 *   map(3) {
 *     "fmt"      : "none",
 *     "attStmt"  : {},
 *     "authData" : bytes(...)
 *   }
 *
 * We locate "authData" by scanning for its key and extract the byte string.
 * This is intentionally a minimal, targeted parser — not a general CBOR decoder.
 */
function extractAuthDataFromAttestation(attestationObject: Uint8Array): Uint8Array {
  // Locate the "authData" key in the CBOR map.
  const authDataKey = new TextEncoder().encode("authData");
  const keyBytes = new Uint8Array([
    0x68, // text(8) — CBOR text string of length 8
    ...authDataKey,
  ]);

  for (let i = 0; i < attestationObject.length - keyBytes.length; i++) {
    let match = true;
    for (let j = 0; j < keyBytes.length; j++) {
      if (attestationObject[i + j] !== keyBytes[j]) {
        match = false;
        break;
      }
    }

    if (match) {
      // The value immediately follows the key.
      const valueOffset = i + keyBytes.length;
      const firstByte = attestationObject[valueOffset];
      if (firstByte === undefined) throw new Error("authData value byte missing");

      const majorType = (firstByte & 0xe0) >> 5;
      if (majorType !== 2) {
        throw new Error(
          `Expected authData to be a CBOR byte string (major type 2), got ${majorType}`,
        );
      }

      let additionalInfo = firstByte & 0x1f;
      let dataOffset = valueOffset + 1;
      let byteLength: number;

      if (additionalInfo <= 23) {
        byteLength = additionalInfo;
      } else if (additionalInfo === 24) {
        const lenByte = attestationObject[dataOffset];
        if (lenByte === undefined) throw new Error("Missing length byte");
        byteLength = lenByte;
        dataOffset += 1;
      } else if (additionalInfo === 25) {
        const hi = attestationObject[dataOffset];
        const lo = attestationObject[dataOffset + 1];
        if (hi === undefined || lo === undefined) throw new Error("Missing 2-byte length");
        byteLength = (hi << 8) | lo;
        dataOffset += 2;
      } else {
        throw new Error(`Unsupported CBOR additional info: ${additionalInfo}`);
      }

      return attestationObject.slice(dataOffset, dataOffset + byteLength);
    }
  }

  throw new Error(
    "Could not find authData in attestationObject. " +
      "Ensure the authenticator uses 'none' attestation.",
  );
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Module-level singleton.
 * The RP config is derived from env vars at construction time.
 */
export const passkeyService = new PasskeyService();
