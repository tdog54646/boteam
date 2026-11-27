// Loaded into each packaged Electron process so Keychain evaluates the app's own signature.
#include <Security/Security.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

static const char service[] = "BoTeam signing regression test";
static const char account[] = "test account";
static const char secret[] = "isolated test value";

static OSStatus createItem(const char *path, const char *password) {
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainCreate(path, (UInt32)strlen(password), password, false, NULL, &keychain);
    if (status == errSecSuccess) {
        status = SecKeychainAddGenericPassword(keychain, sizeof(service) - 1, service,
            sizeof(account) - 1, account, sizeof(secret) - 1, secret, NULL);
    }
    if (keychain) CFRelease(keychain);
    return status;
}

static OSStatus readItem(const char *path, const char *password) {
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainOpen(path, &keychain);
    if (status == errSecSuccess)
        status = SecKeychainUnlock(keychain, (UInt32)strlen(password), password, true);
    UInt32 size = 0;
    void *bytes = NULL;
    if (status == errSecSuccess)
        status = SecKeychainFindGenericPassword(keychain, sizeof(service) - 1, service,
            sizeof(account) - 1, account, &size, &bytes, NULL);
    if (status == errSecSuccess && (size != sizeof(secret) - 1 || memcmp(bytes, secret, size) != 0))
        status = errSecDecode;
    if (bytes) SecKeychainItemFreeContent(NULL, bytes);
    if (keychain) CFRelease(keychain);
    return status;
}

NAPI_MODULE_INIT() {
    const char *operation = getenv("BOTEAM_PROBE_OPERATION");
    const char *path = getenv("BOTEAM_PROBE_KEYCHAIN");
    const char *password = getenv("BOTEAM_PROBE_PASSWORD");
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status == errSecSuccess) {
        if (!path || !password || !operation) status = errSecParam;
        else if (strcmp(operation, "create") == 0) status = createItem(path, password);
        else if (strcmp(operation, "read") == 0) status = readItem(path, password);
        else status = errSecParam;
    }
    napi_value result;
    napi_create_int32(env, status, &result);
    return result;
}
