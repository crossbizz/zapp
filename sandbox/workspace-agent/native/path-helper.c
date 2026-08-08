#if defined(__linux__)
#define _DEFAULT_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/openat2.h>
#include <sys/syscall.h>
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif

enum {
  PATH_HELPER_USAGE = 64,
  PATH_HELPER_PATH_VIOLATION = 65,
  PATH_HELPER_IO_FAILURE = 74,
  PATH_HELPER_CONTAINMENT_FAILURE = 75,
};

static bool is_path_violation_errno(int error_code) {
  return error_code == ELOOP || error_code == EXDEV;
}

static int duplicate_cloexec(int fd) {
#ifdef F_DUPFD_CLOEXEC
  return fcntl(fd, F_DUPFD_CLOEXEC, 0);
#else
  int duplicate = dup(fd);
  if (duplicate >= 0) {
    (void)fcntl(duplicate, F_SETFD, FD_CLOEXEC);
  }
  return duplicate;
#endif
}

static bool is_safe_relative_path(const char *path) {
  if (path == NULL || path[0] == '\0' || path[0] == '/' || strchr(path, '\\') != NULL) {
    return false;
  }

  const char *component = path;
  for (;;) {
    const char *separator = strchr(component, '/');
    size_t length = separator == NULL ? strlen(component) : (size_t)(separator - component);
    if (length == 0 || (length == 2 && component[0] == '.' && component[1] == '.')) {
      return false;
    }
    if (separator == NULL) {
      return true;
    }
    component = separator + 1;
  }
}

static char *copy_slice(const char *source, size_t length) {
  char *copy = malloc(length + 1);
  if (copy == NULL) {
    return NULL;
  }
  memcpy(copy, source, length);
  copy[length] = '\0';
  return copy;
}

static int open_workspace_root(const char *root, bool *path_violation) {
  if (root == NULL || root[0] != '/') {
    *path_violation = true;
    errno = EINVAL;
    return -1;
  }
  int descriptor = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0 && is_path_violation_errno(errno)) {
    *path_violation = true;
  }
  return descriptor;
}

#if defined(__linux__) && defined(SYS_openat2)
static int openat2_beneath(
    int directory_fd,
    const char *path,
    int flags,
    mode_t mode,
    bool *fallback) {
  struct open_how how = {
      .flags = (uint64_t)flags,
      .mode = (uint64_t)mode,
      .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS,
  };
  int descriptor = (int)syscall(SYS_openat2, directory_fd, path, &how, sizeof(how));
  if (descriptor >= 0) {
    return descriptor;
  }
  if (errno == ENOSYS || errno == EINVAL || errno == E2BIG) {
    *fallback = true;
  }
  return -1;
}
#endif

static int open_directory_componentwise(int root_fd, const char *path, bool *path_violation) {
  int current_fd = duplicate_cloexec(root_fd);
  if (current_fd < 0) {
    return -1;
  }

  char *copy = strdup(path);
  if (copy == NULL) {
    close(current_fd);
    return -1;
  }
  char *save = NULL;
  for (char *component = strtok_r(copy, "/", &save); component != NULL;
       component = strtok_r(NULL, "/", &save)) {
    if (strcmp(component, ".") == 0) {
      continue;
    }
    int next_fd = openat(
        current_fd,
        component,
        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next_fd < 0) {
      if (is_path_violation_errno(errno)) {
        *path_violation = true;
      }
      close(current_fd);
      free(copy);
      return -1;
    }
    close(current_fd);
    current_fd = next_fd;
  }
  free(copy);
  return current_fd;
}

static int open_directory_beneath(int root_fd, const char *path, bool *path_violation) {
  if (!is_safe_relative_path(path)) {
    *path_violation = true;
    errno = EINVAL;
    return -1;
  }
  if (strcmp(path, ".") == 0) {
    return duplicate_cloexec(root_fd);
  }

#if defined(__linux__) && defined(SYS_openat2)
  bool fallback = false;
  int descriptor = openat2_beneath(
      root_fd,
      path,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
      0,
      &fallback);
  if (descriptor >= 0) {
    return descriptor;
  }
  if (!fallback) {
    if (is_path_violation_errno(errno)) {
      *path_violation = true;
    }
    return -1;
  }
#endif

  return open_directory_componentwise(root_fd, path, path_violation);
}

static int open_parent_beneath(
    int root_fd,
    const char *path,
    int *parent_fd,
    char **leaf,
    bool *path_violation) {
  if (!is_safe_relative_path(path)) {
    *path_violation = true;
    errno = EINVAL;
    return -1;
  }

  const char *separator = strrchr(path, '/');
  if (separator == NULL) {
    *parent_fd = duplicate_cloexec(root_fd);
    *leaf = strdup(path);
  } else {
    char *parent_path = copy_slice(path, (size_t)(separator - path));
    if (parent_path == NULL) {
      return -1;
    }
    *parent_fd = open_directory_beneath(root_fd, parent_path, path_violation);
    free(parent_path);
    *leaf = strdup(separator + 1);
  }
  if (*parent_fd < 0 || *leaf == NULL) {
    if (*parent_fd >= 0) {
      close(*parent_fd);
    }
    free(*leaf);
    *leaf = NULL;
    return -1;
  }
  if (strcmp(*leaf, ".") == 0) {
    return 0;
  }
  return 0;
}

static int open_final_beneath(
    int parent_fd,
    const char *leaf,
    int flags,
    mode_t mode,
    bool *path_violation) {
#if defined(__linux__) && defined(SYS_openat2)
  bool fallback = false;
  int descriptor = openat2_beneath(
      parent_fd,
      leaf,
      flags | O_NOFOLLOW | O_CLOEXEC,
      mode,
      &fallback);
  if (descriptor >= 0) {
    return descriptor;
  }
  if (!fallback) {
    if (is_path_violation_errno(errno)) {
      *path_violation = true;
    }
    return -1;
  }
#endif

  int fallback_descriptor = openat(parent_fd, leaf, flags | O_NOFOLLOW | O_CLOEXEC, mode);
  if (fallback_descriptor < 0 && is_path_violation_errno(errno)) {
    *path_violation = true;
  }
  return fallback_descriptor;
}

static int pause_after_pinned_descriptor(void) {
  const char *ready_path = getenv("ZAPP_NATIVE_TEST_READY_PATH");
  const char *continue_path = getenv("ZAPP_NATIVE_TEST_CONTINUE_PATH");
  if (ready_path == NULL || continue_path == NULL) {
    return 0;
  }

  int ready_fd = open(ready_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (ready_fd < 0) {
    return -1;
  }
  close(ready_fd);

  const struct timespec delay = {.tv_sec = 0, .tv_nsec = 10 * 1000 * 1000};
  for (int attempts = 0; attempts < 1000; attempts += 1) {
    if (access(continue_path, F_OK) == 0) {
      return 0;
    }
    if (nanosleep(&delay, NULL) != 0 && errno != EINTR) {
      return -1;
    }
  }
  errno = ETIMEDOUT;
  return -1;
}

static int write_all(int output_fd, const char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t bytes_written = write(output_fd, buffer + offset, length - offset);
    if (bytes_written == 0) {
      errno = EIO;
      return -1;
    }
    if (bytes_written < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    offset += (size_t)bytes_written;
  }
  return 0;
}

static int copy_stream(int input_fd, int output_fd) {
  char buffer[64 * 1024];
  for (;;) {
    ssize_t bytes_read = read(input_fd, buffer, sizeof(buffer));
    if (bytes_read == 0) {
      return 0;
    }
    if (bytes_read < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -1;
    }
    if (write_all(output_fd, buffer, (size_t)bytes_read) != 0) {
      return -1;
    }
  }
}

int join_cgroup(const char *procs_path) {
  if (procs_path == NULL || procs_path[0] != '/') {
    errno = EINVAL;
    return -1;
  }
  char pid_text[32];
  int length = snprintf(pid_text, sizeof(pid_text), "%ld\n", (long)getpid());
  if (length < 0 || (size_t)length >= sizeof(pid_text)) {
    errno = EINVAL;
    return -1;
  }
  int write_fd = open(procs_path, O_WRONLY | O_CLOEXEC);
  if (write_fd < 0) {
    return -1;
  }
  int write_result = write_all(write_fd, pid_text, (size_t)length);
  close(write_fd);
  if (write_result != 0) {
    return -1;
  }

  int read_fd = open(procs_path, O_RDONLY | O_CLOEXEC);
  if (read_fd < 0) {
    return -1;
  }
  FILE *members = fdopen(read_fd, "r");
  if (members == NULL) {
    close(read_fd);
    return -1;
  }
  bool found = false;
  char line[64];
  while (fgets(line, sizeof(line), members) != NULL) {
    char *end = NULL;
    long member = strtol(line, &end, 10);
    if (end != line && member == (long)getpid()) {
      found = true;
      break;
    }
  }
  fclose(members);
  if (!found) {
    errno = EPERM;
    return -1;
  }
  return 0;
}

int report_containment_failure(const char *program) {
  (void)fprintf(stderr, "%s: execution containment unavailable\n", program);
  return PATH_HELPER_CONTAINMENT_FAILURE;
}

static char *join_relative_path(const char *prefix, const char *name) {
  size_t prefix_length = strlen(prefix);
  size_t name_length = strlen(name);
  size_t separator_length = prefix_length == 0 ? 0 : 1;
  char *joined = malloc(prefix_length + separator_length + name_length + 1);
  if (joined == NULL) {
    return NULL;
  }
  memcpy(joined, prefix, prefix_length);
  if (separator_length != 0) {
    joined[prefix_length] = '/';
  }
  memcpy(joined + prefix_length + separator_length, name, name_length);
  joined[prefix_length + separator_length + name_length] = '\0';
  return joined;
}

static int write_list_record(char type, const char *path) {
  if (write_all(STDOUT_FILENO, &type, 1) != 0) {
    return -1;
  }
  size_t path_length = strlen(path);
  if (write_all(STDOUT_FILENO, path, path_length) != 0) {
    return -1;
  }
  const char terminator = '\0';
  return write_all(STDOUT_FILENO, &terminator, 1);
}

static int list_directory(
    int directory_fd,
    const char *prefix,
    int depth,
    int max_depth,
    bool *path_violation) {
  int scan_fd = duplicate_cloexec(directory_fd);
  if (scan_fd < 0) {
    return -1;
  }
  DIR *directory = fdopendir(scan_fd);
  if (directory == NULL) {
    close(scan_fd);
    return -1;
  }

  int result = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (entry == NULL) {
      if (errno != 0) {
        result = -1;
      }
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) {
      continue;
    }
    struct stat metadata;
    if (fstatat(directory_fd, entry->d_name, &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
      result = -1;
      break;
    }
    char *relative_path = join_relative_path(prefix, entry->d_name);
    if (relative_path == NULL) {
      result = -1;
      break;
    }
    char type = S_ISDIR(metadata.st_mode) ? 'd' : (S_ISLNK(metadata.st_mode) ? 'l' : 'f');
    if (write_list_record(type, relative_path) != 0) {
      free(relative_path);
      result = -1;
      break;
    }
    if (type == 'd' && depth < max_depth) {
      int child_fd = openat(
          directory_fd,
          entry->d_name,
          O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (child_fd < 0) {
        if (is_path_violation_errno(errno)) {
          *path_violation = true;
        }
        free(relative_path);
        result = -1;
        break;
      }
      result = list_directory(child_fd, relative_path, depth + 1, max_depth, path_violation);
      close(child_fd);
      if (result != 0) {
        free(relative_path);
        break;
      }
    }
    free(relative_path);
  }
  closedir(directory);
  return result;
}

static int parse_max_depth(const char *value, int *max_depth) {
  errno = 0;
  char *end = NULL;
  long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 0 || parsed > INT_MAX) {
    return -1;
  }
  *max_depth = (int)parsed;
  return 0;
}

static int report_failure(const char *program, bool path_violation) {
  const char *message = path_violation ? "unsafe workspace path\n" : "workspace operation failed\n";
  (void)fprintf(stderr, "%s: %s", program, message);
  return path_violation ? PATH_HELPER_PATH_VIOLATION : PATH_HELPER_IO_FAILURE;
}

static int run_read(const char *root, const char *path) {
  bool path_violation = false;
  int root_fd = open_workspace_root(root, &path_violation);
  int parent_fd = -1;
  int file_fd = -1;
  char *leaf = NULL;
  int result = PATH_HELPER_IO_FAILURE;
  if (root_fd < 0 ||
      open_parent_beneath(root_fd, path, &parent_fd, &leaf, &path_violation) != 0 ||
      pause_after_pinned_descriptor() != 0 ||
      (file_fd = open_final_beneath(parent_fd, leaf, O_RDONLY, 0, &path_violation)) < 0 ||
      copy_stream(file_fd, STDOUT_FILENO) != 0) {
    result = report_failure("path-helper", path_violation);
  } else {
    result = 0;
  }
  if (file_fd >= 0) close(file_fd);
  if (parent_fd >= 0) close(parent_fd);
  if (root_fd >= 0) close(root_fd);
  free(leaf);
  return result;
}

static int run_write(const char *root, const char *path) {
  bool path_violation = false;
  int root_fd = open_workspace_root(root, &path_violation);
  int parent_fd = -1;
  int file_fd = -1;
  char *leaf = NULL;
  int result = PATH_HELPER_IO_FAILURE;
  if (root_fd < 0 ||
      open_parent_beneath(root_fd, path, &parent_fd, &leaf, &path_violation) != 0 ||
      pause_after_pinned_descriptor() != 0 ||
      (file_fd = open_final_beneath(
           parent_fd,
           leaf,
           O_WRONLY | O_CREAT | O_TRUNC,
           0666,
           &path_violation)) < 0 ||
      copy_stream(STDIN_FILENO, file_fd) != 0) {
    result = report_failure("path-helper", path_violation);
  } else {
    result = 0;
  }
  if (file_fd >= 0) close(file_fd);
  if (parent_fd >= 0) close(parent_fd);
  if (root_fd >= 0) close(root_fd);
  free(leaf);
  return result;
}

static int run_list(const char *root, const char *path, const char *depth_value) {
  int max_depth = 0;
  bool path_violation = false;
  int root_fd = -1;
  int directory_fd = -1;
  if (parse_max_depth(depth_value, &max_depth) != 0) {
    return PATH_HELPER_USAGE;
  }
  root_fd = open_workspace_root(root, &path_violation);
  if (root_fd < 0 ||
      (directory_fd = open_directory_beneath(root_fd, path, &path_violation)) < 0 ||
      pause_after_pinned_descriptor() != 0 ||
      list_directory(directory_fd, "", 0, max_depth, &path_violation) != 0) {
    int result = report_failure("path-helper", path_violation);
    if (directory_fd >= 0) close(directory_fd);
    if (root_fd >= 0) close(root_fd);
    return result;
  }
  close(directory_fd);
  close(root_fd);
  return 0;
}

int path_helper_main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "read") == 0) {
    return run_read(argv[2], argv[3]);
  }
  if (argc == 4 && strcmp(argv[1], "write") == 0) {
    return run_write(argv[2], argv[3]);
  }
  if (argc == 5 && strcmp(argv[1], "list") == 0) {
    return run_list(argv[2], argv[3], argv[4]);
  }
  (void)fprintf(stderr, "path-helper: invalid invocation\n");
  return PATH_HELPER_USAGE;
}

#ifndef PATH_HELPER_LIBRARY
int main(int argc, char **argv) {
  return path_helper_main(argc, argv);
}
#endif
