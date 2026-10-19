// Local archive adapter for Glovebox's GPL-3.0 telemetry and MP4 playback code.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lubaxe/glovebox-archive/recording/internal/mp4fix"
	"github.com/lubaxe/glovebox-archive/recording/internal/telemetry"
)

var slots = make(chan struct{}, 2)

// roots are the archive mounts recordings may be read from.
var roots = []string{env("SOURCES", "/sources"), env("RETAINED", "/retained")}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// rangeChunk bounds the answer to an open-ended range request ("bytes=N-").
// Browsers ask for the rest as they need it, so a grid of six cameras plus
// the next minute buffering behind it share the browser's six connections
// per host, instead of each video holding one for its whole file.
const rangeChunk = 8 << 20

func capRange(r *http.Request, size int64) {
	h := r.Header.Get("Range")
	var start int64
	if !strings.HasSuffix(h, "-") || strings.Contains(h, ",") {
		return
	}
	if _, err := fmt.Sscanf(h, "bytes=%d-", &start); err != nil || start < 0 {
		return
	}
	if size-start > rangeChunk {
		r.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, start+rangeChunk-1))
	}
}

func openRecording(w http.ResponseWriter, r *http.Request) (*os.File, os.FileInfo) {
	path, err := filepath.EvalSymlinks(r.URL.Query().Get("path"))
	if err != nil {
		http.NotFound(w, r)
		return nil, nil
	}
	allowed := false
	for _, root := range roots {
		rel, err := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, "../") && !filepath.IsAbs(rel) {
			allowed = true
		}
	}
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if strings.EqualFold(part, "EncryptedClips") {
			allowed = false
		}
	}
	if !allowed || !strings.EqualFold(filepath.Ext(path), ".mp4") {
		http.NotFound(w, r)
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return nil, nil
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		http.NotFound(w, r)
		return nil, nil
	}
	return file, info
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /media", func(w http.ResponseWriter, r *http.Request) {
		file, info := openRecording(w, r)
		if file == nil {
			return
		}
		defer file.Close()
		playable, err := mp4fix.NewFile(file, info.Size())
		if err != nil {
			http.Error(w, "Recording cannot be played", 422)
			return
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		capRange(r, info.Size())
		http.ServeContent(w, r, info.Name(), info.ModTime(), playable)
	})
	mux.HandleFunc("GET /telemetry", func(w http.ResponseWriter, r *http.Request) {
		file, info := openRecording(w, r)
		if file == nil {
			return
		}
		defer file.Close()
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-ctx.Done():
			http.Error(w, "Telemetry busy", 503)
			return
		}
		result, err := telemetry.Extract(ctx, file, info.Size())
		if err != nil {
			http.Error(w, "No readable telemetry", 422)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		json.NewEncoder(w).Encode(result)
	})
	server := &http.Server{Addr: env("LISTEN", "127.0.0.1:8001"), Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
