package com.dom.bilidownloader;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class CookieVault {
    private static final String ALIAS = "bili-login-cookies";
    private final SharedPreferences preferences;
    CookieVault(Context context) { preferences = context.getSharedPreferences("bili", Context.MODE_PRIVATE); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    synchronized void save(String value) {
        try {
            if (value.isEmpty()) { clear(); return; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            String payload = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            preferences.edit().putString("cookies_encrypted", payload).remove("cookies").apply();
        } catch (Exception error) { clear(); } // No plaintext fallback.
    }
    synchronized String load() {
        String legacy = preferences.getString("cookies", "");
        if (!legacy.isEmpty()) { save(legacy); return legacy; }
        try {
            String payload = preferences.getString("cookies_encrypted", ""); if (payload.isEmpty()) return "";
            String[] parts = payload.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception error) { clear(); return ""; }
    }
    synchronized void clear() { preferences.edit().remove("cookies").remove("cookies_encrypted").apply(); }
}
