// Command macr serves the multi-agent code review console.
//
//	macr web              serve the console at http://127.0.0.1:3080
//	macr web --run r.json serve a specific run
//	macr version
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	macr "github.com/zzxwill/multi-agents-code-review"
)

const version = "0.1.0"

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "web":
		if err := web(os.Args[2:]); err != nil {
			log.Fatalf("macr: %v", err)
		}
	case "version", "-v", "--version":
		fmt.Println("macr " + version)
	case "help", "-h", "--help":
		usage()
	default:
		log.Printf("macr: unknown command %q", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Print(`macr — multi-agent code review console

Usage:
  macr web [flags]     serve the console
  macr version

Flags for web:
  --port int     port to listen on (default 3080; the next free port is used if taken)
  --run string   run.json to serve at /api/run (default ./run.json if present)
  --open         open a browser once the server is up
`)
}

func web(args []string) error {
	fs := flag.NewFlagSet("web", flag.ExitOnError)
	port := fs.Int("port", 3080, "port to listen on")
	runFile := fs.String("run", "", "run.json to serve (default ./run.json if present)")
	open := fs.Bool("open", false, "open a browser once the server is up")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ui, live, err := macr.UI()
	if err != nil {
		return fmt.Errorf("assets: %w", err)
	}

	runPath, err := resolveRun(*runFile)
	if err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.Handle("/", noCache(http.FileServer(http.FS(ui))))
	mux.HandleFunc("/api/run", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		// Resolve per request. A run is generated while the console is already
		// up, so a file that did not exist at startup must still be picked up.
		path := runPath
		if path == "" {
			if _, err := os.Stat("run.json"); err == nil {
				path = "run.json"
			}
		}
		if path == "" {
			http.Error(w, `{"error":"no run file"}`, http.StatusNotFound)
			return
		}
		// Read per request, so editing run.json shows up on refresh.
		b, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, `{"error":"unreadable run file"}`, http.StatusInternalServerError)
			return
		}
		if !json.Valid(b) {
			http.Error(w, `{"error":"run file is not valid json"}`, http.StatusUnprocessableEntity)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	})
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "version": version, "run": runPath, "assets": assetSource(live),
		})
	})

	ln, addr, err := listen(*port)
	if err != nil {
		return err
	}

	log.Printf("assets:  %s", assetSource(live))
	if runPath == "" {
		log.Printf("run:     none found — serving the run embedded in the page")
	} else {
		log.Printf("run:     %s", runPath)
	}
	url := "http://" + addr
	log.Printf("console: %s", url)

	if *open {
		go func() {
			time.Sleep(150 * time.Millisecond)
			if err := openBrowser(url); err != nil {
				log.Printf("could not open a browser: %v", err)
			}
		}()
	}

	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	return srv.Serve(ln)
}

func assetSource(live bool) string {
	if live {
		return "./web (edits reload)"
	}
	return "embedded"
}

// resolveRun validates an explicit --run and returns its absolute path. An
// empty result means "look for ./run.json per request" — a run file is often
// generated after the console is already serving.
func resolveRun(flagVal string) (string, error) {
	if flagVal == "" {
		return "", nil
	}
	abs, err := filepath.Abs(flagVal)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(abs); err != nil {
		return "", fmt.Errorf("run file %s: %w", abs, err)
	}
	return abs, nil
}

// listen binds port, or the next free one, so a second console does not die on
// "address already in use". The last error is returned if none are free.
func listen(port int) (net.Listener, string, error) {
	var lastErr error
	for p := port; p < port+20; p++ {
		addr := fmt.Sprintf("127.0.0.1:%d", p)
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			if p != port {
				log.Printf("port %d busy, using %d", port, p)
			}
			return ln, addr, nil
		}
		lastErr = err
	}
	return nil, "", fmt.Errorf("no free port in %d-%d: %w", port, port+19, lastErr)
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
