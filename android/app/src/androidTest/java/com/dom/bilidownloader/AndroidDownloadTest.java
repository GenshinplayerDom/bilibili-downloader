package com.dom.bilidownloader;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.rule.ActivityTestRule;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(AndroidJUnit4.class)
public class AndroidDownloadTest {
    @Rule
    public ActivityTestRule<MainActivity> activityRule = new ActivityTestRule<>(MainActivity.class);

    private Activity activity;
    private Object bridge;
    private LocalMediaServer server;
    private final Set<String> names = new HashSet<>();

    @Before
    public void setUp() throws Exception {
        activity = activityRule.getActivity();
        Field field = MainActivity.class.getDeclaredField("bridge");
        field.setAccessible(true);
        bridge = field.get(activity);
        assertNotNull(bridge);
        server = new LocalMediaServer();
        server.put("/video.mp4", asset("video.mp4"), "video/mp4");
        server.put("/audio.m4a", asset("audio.m4a"), "audio/mp4");
    }

    @After
    public void tearDown() throws Exception {
        for (String name : names) deleteManaged(name);
        if (server != null) server.close();
    }

    @Test
    public void directDownloadWritesExactBytesToMediaStore() throws Exception {
        String name = name("direct", ".mp4");
        server.put("/direct.mp4", asset("video.mp4"), "video/mp4");
        call("downloadMulti", new Class<?>[]{String.class, String.class, String.class},
                server.url("/direct.mp4"), name, "directTest");
        awaitJobRemoved("directTest");
        assertTrue(managed().contains(name));
        assertArrayEquals(asset("video.mp4"), readManaged(name));
    }

    @Test
    public void http412RetriesTheSameSingleCdnUrl() throws Exception {
        String name = name("retry", ".mp4");
        server.put("/retry.mp4", asset("video.mp4"), "video/mp4");
        server.failFirst("/retry.mp4", 412, 1);
        call("downloadMulti", new Class<?>[]{String.class, String.class, String.class},
                server.url("/retry.mp4"), name, "retryTest");
        awaitJobRemoved("retryTest");
        assertEquals(2, server.hits("/retry.mp4"));
        assertArrayEquals(asset("video.mp4"), readManaged(name));
    }

    @Test
    public void emptyResponseIsRejectedWithoutLeavingFile() throws Exception {
        String name = name("empty", ".mp4");
        server.put("/empty.mp4", new byte[0], "video/mp4");
        call("downloadMulti", new Class<?>[]{String.class, String.class, String.class},
                server.url("/empty.mp4"), name, "emptyTest");
        awaitJobRemoved("emptyTest");
        assertFalse(managed().contains(name));
        assertNullManaged(name);
    }

    @Test
    public void htmlErrorPageIsNeverSavedAsVideo() throws Exception {
        String name = name("html", ".mp4");
        server.put("/error.mp4", "<html>risk control</html>".getBytes(StandardCharsets.UTF_8), "text/html; charset=utf-8");
        call("downloadMulti", new Class<?>[]{String.class, String.class, String.class},
                server.url("/error.mp4"), name, "htmlTest");
        awaitJobRemoved("htmlTest");
        assertFalse(managed().contains(name));
        assertNullManaged(name);
    }

    @Test
    public void dashMuxProducesPlayableVideoAndAudioTracks() throws Exception {
        String name = name("mux", ".mp4");
        call("muxDASH", new Class<?>[]{String.class, String.class, String.class, String.class},
                server.url("/video.mp4"), server.url("/audio.m4a"), name, "muxTest");
        awaitJobRemoved("muxTest");
        assertTrue(managed().contains(name));
        Uri uri = managedUri(name);
        assertNotNull(uri);
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(activity, uri, null);
            boolean video = false;
            boolean audio = false;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat format = extractor.getTrackFormat(i);
                String mime = format.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) video = true;
                if (mime != null && mime.startsWith("audio/")) audio = true;
                assertTrue(!format.containsKey(MediaFormat.KEY_DURATION) || format.getLong(MediaFormat.KEY_DURATION) > 0);
            }
            assertTrue(video);
            assertTrue(audio);
        } finally {
            extractor.release();
        }
    }

    @Test
    public void concurrentChunkSavesKeepIndependentContents() throws Exception {
        String first = name("first", ".mp3");
        String second = name("second", ".mp3");
        byte[] firstBytes = "first-download-content".getBytes(StandardCharsets.UTF_8);
        byte[] secondBytes = "second-download-content-with-different-length".getBytes(StandardCharsets.UTF_8);
        assertEquals(Boolean.TRUE, call("saveStart", new Class<?>[]{String.class, int.class, String.class}, first, 1, "chunkA"));
        assertEquals(Boolean.TRUE, call("saveStart", new Class<?>[]{String.class, int.class, String.class}, second, 1, "chunkB"));
        assertEquals(Boolean.TRUE, call("saveChunk", new Class<?>[]{String.class, String.class}, "chunkA", Base64.encodeToString(firstBytes, Base64.NO_WRAP)));
        assertEquals(Boolean.TRUE, call("saveChunk", new Class<?>[]{String.class, String.class}, "chunkB", Base64.encodeToString(secondBytes, Base64.NO_WRAP)));
        call("saveFinish", new Class<?>[]{String.class, boolean.class}, "chunkA", true);
        call("saveFinish", new Class<?>[]{String.class, boolean.class}, "chunkB", true);
        assertArrayEquals(firstBytes, readManaged(first));
        assertArrayEquals(secondBytes, readManaged(second));
    }

    private String name(String stem, String extension) {
        String value = "android-" + stem + "-" + System.nanoTime() + extension;
        names.add(value);
        return value;
    }

    private SharedPreferences managed() {
        return activity.getSharedPreferences("managed_downloads", Activity.MODE_PRIVATE);
    }

    private Uri managedUri(String name) {
        String value = managed().getString(name, "");
        return value.startsWith("content://") ? Uri.parse(value) : null;
    }

    private byte[] readManaged(String name) throws IOException {
        Uri uri = managedUri(name);
        assertNotNull(uri);
        InputStream in = activity.getContentResolver().openInputStream(uri);
        assertNotNull(in);
        try { return readAll(in); } finally { in.close(); }
    }

    private void assertNullManaged(String name) {
        assertFalse(managed().contains(name));
        Cursor cursor = activity.getContentResolver().query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.MediaColumns._ID},
                MediaStore.MediaColumns.DISPLAY_NAME + "=?", new String[]{name}, null);
        if (cursor != null) {
            try { assertFalse("失败任务残留了下载文件", cursor.moveToFirst()); } finally { cursor.close(); }
        }
    }

    private void deleteManaged(String name) {
        Uri uri = managedUri(name);
        if (uri != null) {
            try { activity.getContentResolver().delete(uri, null, null); } catch (Exception ignored) { }
        }
        managed().edit().remove(name).apply();
    }

    private Object call(String name, Class<?>[] signature, Object... args) throws Exception {
        Method method = bridge.getClass().getMethod(name, signature);
        method.setAccessible(true);
        return method.invoke(bridge, args);
    }

    @SuppressWarnings("unchecked")
    private void awaitJobRemoved(String cbId) throws Exception {
        Field field = bridge.getClass().getDeclaredField("jobs");
        field.setAccessible(true);
        Map<String, Object> jobs = (Map<String, Object>) field.get(bridge);
        long deadline = SystemClock.elapsedRealtime() + 20000;
        while (jobs.containsKey(cbId) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50);
        assertFalse("下载任务未在 20 秒内结束: " + cbId, jobs.containsKey(cbId));
    }

    private byte[] asset(String name) throws IOException {
        InputStream in = InstrumentationRegistry.getInstrumentation().getContext().getAssets().open(name);
        try { return readAll(in); } finally { in.close(); }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
        return out.toByteArray();
    }

    private static class LocalMediaServer implements Closeable {
        private final ServerSocket socket;
        private final ExecutorService executor = Executors.newCachedThreadPool();
        private final Map<String, Response> responses = new ConcurrentHashMap<>();
        private final Map<String, AtomicInteger> requestHits = new ConcurrentHashMap<>();
        private final Map<String, Integer> errorsRemaining = new HashMap<>();
        private final Map<String, Integer> errorStatuses = new HashMap<>();
        private volatile boolean running = true;

        LocalMediaServer() throws IOException {
            socket = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
            executor.execute(this::acceptLoop);
        }

        void put(String path, byte[] body, String mime) {
            responses.put(path, new Response(body, mime));
        }

        void failFirst(String path, int status, int count) {
            synchronized (errorsRemaining) {
                errorStatuses.put(path, status);
                errorsRemaining.put(path, count);
            }
        }

        int hits(String path) {
            AtomicInteger value = requestHits.get(path);
            return value == null ? 0 : value.get();
        }

        String url(String path) {
            return "http://127.0.0.1:" + socket.getLocalPort() + path;
        }

        private void acceptLoop() {
            while (running) {
                try {
                    Socket client = socket.accept();
                    executor.execute(() -> serve(client));
                } catch (IOException error) {
                    if (running) error.printStackTrace();
                    return;
                }
            }
        }

        private void serve(Socket client) {
            try (Socket connection = client) {
                connection.setSoTimeout(5000);
                BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.ISO_8859_1));
                String request = reader.readLine();
                if (request == null) return;
                String line;
                while ((line = reader.readLine()) != null && !line.isEmpty()) { }
                String[] parts = request.split(" ");
                String path = parts.length > 1 ? parts[1] : "/";
                int query = path.indexOf('?');
                if (query >= 0) path = path.substring(0, query);
                requestHits.computeIfAbsent(path, key -> new AtomicInteger()).incrementAndGet();
                Response response = responses.get(path);
                int forcedStatus = 0;
                synchronized (errorsRemaining) {
                    Integer left = errorsRemaining.get(path);
                    if (left != null && left > 0) {
                        forcedStatus = errorStatuses.get(path);
                        if (left == 1) errorsRemaining.remove(path);
                        else errorsRemaining.put(path, left - 1);
                    }
                }
                OutputStream out = connection.getOutputStream();
                if (forcedStatus != 0) {
                    byte[] body = "risk control".getBytes(StandardCharsets.UTF_8);
                    writeHeader(out, forcedStatus, "text/plain", body.length);
                    out.write(body);
                } else if (response == null) {
                    byte[] body = "not found".getBytes(StandardCharsets.UTF_8);
                    writeHeader(out, 404, "text/plain", body.length);
                    out.write(body);
                } else {
                    writeHeader(out, 200, response.mime, response.body.length);
                    out.write(response.body);
                }
                out.flush();
            } catch (IOException ignored) { }
        }

        private static void writeHeader(OutputStream out, int status, String mime, int length) throws IOException {
            String reason = status == 200 ? "OK" : "Not Found";
            String header = String.format(Locale.US,
                    "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\nAccept-Ranges: none\r\n\r\n",
                    status, reason, mime, length);
            out.write(header.getBytes(StandardCharsets.ISO_8859_1));
        }

        @Override
        public void close() {
            running = false;
            try { socket.close(); } catch (IOException ignored) { }
            executor.shutdownNow();
        }

        private static class Response {
            final byte[] body;
            final String mime;
            Response(byte[] body, String mime) {
                this.body = body;
                this.mime = mime;
            }
        }
    }
}
