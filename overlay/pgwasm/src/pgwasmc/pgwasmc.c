/*-------------------------------------------------------------------------
 *
 * pgwasmc.c
 *	  pgwasm-postgres libc overrides
 *
 *
 *
 * NOTES
 *    this file contains "libc" function wrappers for pgwasm-postgres, as well as
 *    other flags used by PostgreSQL and needed by pgwasm-postgres. These are
 *    needed in order to emulate some system calls related to sockets, 
 *    user management etc.
 *
 *-------------------------------------------------------------------------
 */

#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/shm.h>
#include <errno.h>
#include <time.h>
#include <pwd.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <setjmp.h>
#include <string.h>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
// TODO: an include for libpgwasm
#endif

volatile int is_pgwasm_active = 0;
volatile int pgwasm_exit_status = -1;

void EMSCRIPTEN_KEEPALIVE clear_setitimer(void) {
    struct itimerval zero = {{0, 0}, {0, 0}};
    setitimer(ITIMER_REAL, &zero, NULL);
}

int pgwasm_setPostgresActive(int newValue) {
	int current = is_pgwasm_active;
	is_pgwasm_active = newValue;
    if (newValue == 0) {
        clear_setitimer();
    }
	return current;
}

int EMSCRIPTEN_KEEPALIVE pgwasm_getPostgresExitStatus() {
    return pgwasm_exit_status;
}

int EMSCRIPTEN_KEEPALIVE pgwasm_setPostgresExitStatus(int status) {
    int prev = pgwasm_exit_status;
    pgwasm_exit_status = status;
    return prev;
}

/* ========== Top level exception handling ==========
*
* In Postgres, the top level sigsetjmp handles exceptions encountered during executions
* In pgwasm-postgres, we handle the top level sigsetjmp manually by exiting on the corresponding longjmp
* with a predefined exit code (POSTGRES_MAIN_LONGJMP). We only need to override the longjmp 
* because setjmp already behaves as expected.
* This keeps the code changes cleaner.
*/

#define POSTGRES_MAIN_LONGJMP 100

volatile sigjmp_buf	postgresmain_sigjmp_buf;

volatile bool ignore_till_sync = false;
volatile bool send_ready_for_query = false;

/*
* This wraps the libc longjmp() to enable us to intercept and handle the main longjmp manually
*/
void EMSCRIPTEN_KEEPALIVE pgwasm_longjmp(jmp_buf env, int val) {
    if (is_pgwasm_active && memcmp(env, (void*)postgresmain_sigjmp_buf, sizeof(jmp_buf)) == 0) {
        // reset this as it is expected
        if (!ignore_till_sync)
		    send_ready_for_query = true;	/* initially, or after error */
        pgwasm_exit_status = POSTGRES_MAIN_LONGJMP;
        emscripten_exit_with_live_runtime();
    }
    longjmp(env, val);
}

// emscripten defines siglongjmp as longjmp
void EMSCRIPTEN_KEEPALIVE pgwasm_siglongjmp(sigjmp_buf env, int val) {
    pgwasm_longjmp(env, val);
}

/* ========== Process handling functions ==========
*
* We wrap some process handling functions to emulate 
* the behavior of an OS when instantiating a new process.
* This is not available in emscripten atm, so we handle it manually
* See scripts/lib/driver/initdb.ts in pgwasm-postgres for the host-side callbacks.
*/
typedef ssize_t (*pgwasm_system_callback_t)(const char *command);
pgwasm_system_callback_t pgwasm_system_callback = NULL;

void EMSCRIPTEN_KEEPALIVE
pgwasm_set_system_fn(pgwasm_system_callback_t system_fn) {
    pgwasm_system_callback = system_fn;
}

int EMSCRIPTEN_KEEPALIVE
pgwasm_system(const char *command) {
    if (pgwasm_system_callback) {
        return pgwasm_system_callback(command);
    }
    // if pgwasm_system_callback is not set, we assume we cannot exec that command and return != 0
    // we could also just call system() and let it crash, but this leads to some stderr messages on Windows
    return 123;
}

typedef FILE* (*pgwasm_popen_callback_t)(const char *command, const char *mode);
pgwasm_popen_callback_t pgwasm_popen_callback = NULL;

void EMSCRIPTEN_KEEPALIVE
pgwasm_set_popen_fn(pgwasm_popen_callback_t popen_fn) {
    pgwasm_popen_callback = popen_fn;
}

FILE* EMSCRIPTEN_KEEPALIVE
pgwasm_popen(const char *command, const char *mode) {
    if (pgwasm_popen_callback) {
        return pgwasm_popen_callback(command, mode);
    }
    return popen(command, mode);
}

typedef int (*pgwasm_pclose_callback_t)(FILE* stream);
pgwasm_pclose_callback_t pgwasm_pclose_callback = NULL;

void EMSCRIPTEN_KEEPALIVE
pgwasm_set_pclose_fn(pgwasm_pclose_callback_t pclose_fn) {
    pgwasm_pclose_callback = pclose_fn;
}

int EMSCRIPTEN_KEEPALIVE
pgwasm_pclose(FILE* stream) {
    if (pgwasm_pclose_callback) {
        return pgwasm_pclose_callback(stream);
    }
    return pclose(stream);
}

/* ========== User related functions ==========
*
* PostgreSQL code expects the current user to fulfill certain criteria to be allowed to run the process, otherwise it exits. 
* This is irrelevant in WASM/emscripten, so we fake the expected data to match what Postgres wants.
*/

#define PGWASM_UID 123

uid_t EMSCRIPTEN_KEEPALIVE
pgwasm_geteuid(void) {
    return PGWASM_UID;
}

uid_t EMSCRIPTEN_KEEPALIVE
pgwasm_getuid(void) {
    return PGWASM_UID;
}

struct passwd* EMSCRIPTEN_KEEPALIVE
pgwasm_getpwuid(uid_t uid) {
    static struct passwd pw;
    static char name[] = "postgres";
    static char passwd[] = "x";
    static char gecos[] = "Static User";
    static char dir[] = "/home/postgres";
    static char shell[] = "/bin/sh";

    pw.pw_name   = name;
    pw.pw_passwd = passwd;
    pw.pw_uid    = uid;
    pw.pw_gid    = uid;
    pw.pw_gecos  = gecos;
    pw.pw_dir    = dir;
    pw.pw_shell  = shell;

    return &pw;
}

/* ========== atexit functions ==========
*
* atexit registered functions provide important functionality in Postgres
* we need to be able to run them when closing pgwasm-postgres.
*/
#define MAX_ATEXIT_FUNCS 32

static void (*atexit_funcs[MAX_ATEXIT_FUNCS])(void);
static int atexit_func_count = 0;

int EMSCRIPTEN_KEEPALIVE pgwasm_atexit(void (*function)(void)) {
    if (atexit_func_count >= MAX_ATEXIT_FUNCS) {
        // According to the C standard, atexit returns nonzero on failure.
        return -1;
    }
    atexit_funcs[atexit_func_count++] = function;
    return 0;
}

void EMSCRIPTEN_KEEPALIVE pgwasm_run_atexit_funcs(void) {
    // Call in reverse registration order
    for (int i = atexit_func_count - 1; i >= 0; --i) {
        if (atexit_funcs[i]) {
            atexit_funcs[i]();
        }
    }
    atexit_func_count = 0;
}

/* ========== streams functions ==========
*
* initdb communicates with postgres via stdin<->stdout redirection
* we need to handle this manually mainly because we're also handling processes manually
*/

FILE* pgwasm_stdin = NULL;
FILE* pgwasm_stdout = NULL;

/*
* we override exit() to make sure we cleanup the stdin/stdout file descriptors
*/
void EMSCRIPTEN_KEEPALIVE
pgwasm_exit(int status) {
    if (pgwasm_stdin != NULL) {
        fclose(pgwasm_stdin);
        pgwasm_stdin = NULL;
    }
    if (pgwasm_stdout != NULL) {
        fflush(pgwasm_stdout);
        fclose(pgwasm_stdout);
        pgwasm_stdout = NULL;
    }
    optind = 1;
    pgwasm_exit_status = -1;
    exit(status);
}

/*
* Overrides freopen() libc function to allow initdb<->pgwasm-postgres comm via standard streams (see initdb.ts in frontend)
*/
FILE * EMSCRIPTEN_KEEPALIVE
pgwasm_freopen(const char *pathname, const char *mode, int streamid) {
    if (streamid == 0) {
        pgwasm_stdin = freopen(pathname, mode, stdin);
        return pgwasm_stdin;
    }
    if (streamid == 1) {
        pgwasm_stdout = freopen(pathname, mode, stdout);
        return pgwasm_stdout;
    }
    if (streamid == 2) {
        return freopen(pathname, mode, stderr);
    }
    return NULL;
}

// ============ SHM ===============

typedef struct ShmSegment {
    int shmid;
    key_t key;
    size_t size;
    void *addr;
    int shmflg;
    struct ShmSegment *next;
} ShmSegment;

static ShmSegment *shm_list = NULL;
static unsigned int next_shmid = 1;

// shmget replacement
int EMSCRIPTEN_KEEPALIVE
pgwasm_shmget(key_t key, size_t size, int shmflg) {
    ShmSegment *seg = shm_list;

    // Search for existing segment
    while (seg) {
        if (seg->key == key) return seg->shmid;
        seg = seg->next;
    }

    // If IPC_CREAT is set, create new segment
    if (shmflg & IPC_CREAT) {
        int pagesize = getpagesize();
        while (pagesize < size) pagesize += pagesize;
        void *mem = malloc(pagesize);
        if (!mem) {
            errno = ENOMEM;
            return -1;
        }

        ShmSegment *new_seg = malloc(sizeof(ShmSegment));
        if (!new_seg) {
            free(mem);
            errno = ENOMEM;
            return -1;
        }

        new_seg->shmid = next_shmid++;
        new_seg->key = key;
        new_seg->size = size;
        new_seg->addr = mem;
        new_seg->shmflg = shmflg;
        new_seg->next = shm_list;
        shm_list = new_seg;

        return new_seg->shmid;
    }

    errno = ENOENT;
    return -1;
}

// shmat replacement
void EMSCRIPTEN_KEEPALIVE
*pgwasm_shmat(int shmid, const void *shmaddr, int shmflg) {
    ShmSegment *seg = shm_list;

    while (seg) {
        if (seg->shmid == shmid) {
            return seg->addr;
        }
        seg = seg->next;
    }

    errno = EINVAL;
    return (void *)-1;
}

// shmdt replacement
int EMSCRIPTEN_KEEPALIVE
pgwasm_shmdt(const void *shmaddr) {
    ShmSegment *seg = shm_list;

    while (seg) {
        if (seg->addr == shmaddr) {
            return 0;
        }
        seg = seg->next;
    }

    errno = EINVAL;
    return -1;
}

// shmctl replacement
int EMSCRIPTEN_KEEPALIVE
pgwasm_shmctl(int shmid, int cmd, struct shmid_ds *buf) {
    ShmSegment *seg = shm_list;
    ShmSegment *prev = NULL;

    while (seg) {
        if (seg->shmid == shmid) {
            if (cmd == IPC_RMID) {
                free(seg->addr);
                if (prev) prev->next = seg->next;
                else shm_list = seg->next;
                free(seg);
                return 0;
            } else if (cmd == IPC_STAT && buf != NULL) {
                buf->shm_segsz = seg->size;
                buf->shm_perm.__key = seg->key;
                buf->shm_nattch = 0;
                buf->shm_atime = buf->shm_dtime = buf->shm_ctime = time(NULL);
                return 0;
            } else if (cmd == IPC_SET && buf != NULL) {
                seg->size = buf->shm_segsz;
                return 0;
            } else {
                fprintf(stderr, "pgwasmc: shmctl: no such cmd %d\n", cmd);
                errno = EINVAL;
                return -1;
            }
        }
        prev = seg;
        seg = seg->next;
    }

    fprintf(stderr, "pgwasmc: shmctl: no such segment %d\n", shmid);
    errno = EINVAL;
    return -1;
}

/* ========== MMAP/MUNMAP ==========
 * Dummy munmap implementation for emscripten.
 * Emscripten's munmap can corrupt unrelated files in MEMFS,
 * so we just return success without doing anything.
 * Memory will be reclaimed when the WASM instance terminates.
 */
int EMSCRIPTEN_KEEPALIVE
pgwasm_munmap(void *addr, size_t length) {
    (void)addr;
    (void)length;
    // dummy
    return 0;
}

/* ============ SOCKET EMULATION =============
*
* To exchange data between the backend (Postgres) and frontend (JS part of pgwasm-postgres),
* we emulate a socket by overriding the following libc functions.
*/

/* 
* read FROM JS
* Callback used for reading data from the frontend
*/
typedef ssize_t (*pgwasm_read_t)(void *buffer, size_t max_length);
pgwasm_read_t pgwasm_read;

/* write TO JS
* Callback used for writing data to the frontend
*/
typedef ssize_t (*pgwasm_write_t)(void *buffer, size_t length);
pgwasm_write_t pgwasm_write;

/*
* Set the above callbacks
*/
void EMSCRIPTEN_KEEPALIVE
pgwasm_set_rw_cbs(pgwasm_read_t read_cb, pgwasm_write_t write_cb) {
    pgwasm_read = read_cb;
    pgwasm_write = write_cb;
}

int EMSCRIPTEN_KEEPALIVE pgwasm_fcntl(int __fd, int __cmd, ...) {
	// dummy 
	return 0;
}

int EMSCRIPTEN_KEEPALIVE pgwasm_setsockopt(int __fd, int __level, int __optname,
	const void *__optval, socklen_t __optlen) {
	// dummy 
	return 0;
}

int EMSCRIPTEN_KEEPALIVE pgwasm_getsockopt(int __fd, int __level, int __optname,
	void *__restrict __optval,
	socklen_t *__restrict __optlen) {
	// dummy 
	return 0;
}

int EMSCRIPTEN_KEEPALIVE pgwasm_getsockname(int __fd, struct sockaddr * __addr,
	socklen_t *__restrict __len) {
	// dummy 
	return 0;
}

/*
* Overrides the recv() libc function
*/

ssize_t EMSCRIPTEN_KEEPALIVE pgwasm_recv(int __fd, void *__buf, size_t __n, int __flags) {
	ssize_t got = pgwasm_read(__buf, __n);
	return got;
}

/*
* Overrides the send() libc function
*/

ssize_t EMSCRIPTEN_KEEPALIVE pgwasm_send(int __fd, const void *__buf, size_t __n, int __flags) {
	ssize_t wrote = pgwasm_write(__buf, __n);
	return wrote;
}

int EMSCRIPTEN_KEEPALIVE pgwasm_connect(int socket, const struct sockaddr *address, socklen_t address_len) {
	// dummy
	return 0;
}

/*
* Overrides the socket() libc function. The host carries every connection (pgwasm_send and pgwasm_recv above), so the
* descriptor only has to exist until it is closed: every other call on it is one of the overrides above (connect,
* poll, fcntl, the socket options). It is a descriptor of /dev/null. Emscripten's SOCKFS creates AF_INET sockets
* only since 6.0, and libpq connects over a Unix socket by default (pg_dump does), which failed with
* EAFNOSUPPORT; a SOCKFS socket would also bring SOCKFS into every program this file is linked into.
*/
int EMSCRIPTEN_KEEPALIVE pgwasm_socket(int domain, int type, int protocol) {
	(void)domain;
	(void)type;
	(void)protocol;
	return open("/dev/null", O_RDWR);
}

struct pollfd {
    int   fd;         /* file descriptor */
    short events;     /* requested events */
	short revents;    /* returned events */
};

int EMSCRIPTEN_KEEPALIVE pgwasm_poll(struct pollfd fds[], ssize_t nfds, int timeout) {
    // dummy
	return nfds;
}
