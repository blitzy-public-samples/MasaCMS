// The legacy servlet container's request-head limit and its answer to a head over it.

/** Largest request head (request line, header lines and blank line) the legacy container accepts, in bytes. */
export const LEGACY_REQUEST_HEAD_LIMIT_BYTES = 1024 * 1024;

/** The container's whole answer to a head it refuses: an empty 400 that closes the connection, without Date, Generator or HSTS. */
export const LEGACY_BAD_REQUEST_RESPONSE = 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
