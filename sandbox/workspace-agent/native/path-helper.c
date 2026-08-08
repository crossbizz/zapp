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
  PATH_HELPER_VALIDATION_FAILURE = 66,
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

static int read_exact(int input_fd, char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t bytes_read = read(input_fd, buffer + offset, length - offset);
    if (bytes_read == 0) {
      errno = EIO;
      return -1;
    }
    if (bytes_read < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)bytes_read;
  }
  return 0;
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

typedef struct {
  int parent_fd;
  char *leaf;
  size_t length;
  bool exists;
  mode_t mode;
  dev_t device;
  ino_t inode;
  char stage[96];
  char backup[96];
  bool backed_up;
  bool committed;
} atomic_entry;

static void close_atomic_entries(atomic_entry *entries, size_t count) {
  for (size_t index = 0; index < count; index += 1) {
    if (entries[index].parent_fd >= 0) close(entries[index].parent_fd);
    free(entries[index].leaf);
  }
  free(entries);
}

static int parse_size(const char *value, size_t *result) {
  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed > SIZE_MAX) return -1;
  *result = (size_t)parsed;
  return 0;
}

static bool same_parent(int left_fd, int right_fd) {
  struct stat left;
  struct stat right;
  return fstat(left_fd, &left) == 0 && fstat(right_fd, &right) == 0 &&
      left.st_dev == right.st_dev && left.st_ino == right.st_ino;
}

static int probe_absent_aliases(atomic_entry *entries, size_t count) {
  for (size_t left = 0; left < count; left += 1) {
    if (entries[left].exists) continue;
    for (size_t right = left + 1; right < count; right += 1) {
      if (entries[right].exists || !same_parent(entries[left].parent_fd, entries[right].parent_fd)) {
        continue;
      }
      char probe[96];
      (void)snprintf(probe, sizeof(probe), ".zapp-name-probe-%ld-%zu-%zu", (long)getpid(), left, right);
      if (mkdirat(entries[left].parent_fd, probe, 0700) != 0) return -1;
      int probe_fd = openat(entries[left].parent_fd, probe, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (probe_fd < 0) {
        (void)unlinkat(entries[left].parent_fd, probe, AT_REMOVEDIR);
        return -1;
      }
      int first_fd = openat(probe_fd, entries[left].leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
      int first_error = errno;
      if (first_fd >= 0) close(first_fd);
      int second_fd = first_fd < 0 ? -1 : openat(probe_fd, entries[right].leaf, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
      int second_error = errno;
      if (second_fd >= 0) close(second_fd);
      (void)unlinkat(probe_fd, entries[left].leaf, 0);
      (void)unlinkat(probe_fd, entries[right].leaf, 0);
      close(probe_fd);
      (void)unlinkat(entries[left].parent_fd, probe, AT_REMOVEDIR);
      if (first_fd < 0) {
        errno = first_error;
        return -1;
      }
      if (second_fd < 0) {
        if (second_error == EEXIST) return PATH_HELPER_VALIDATION_FAILURE;
        errno = second_error;
        return -1;
      }
    }
  }
  return 0;
}

static int run_atomic_write(int argc, char **argv) {
  size_t count = 0;
  if (argc < 6 || ((argc - 4) % 2) != 0 || parse_size(argv[3], &count) != 0 ||
      count == 0 || (size_t)(argc - 4) != count * 2) {
    return PATH_HELPER_USAGE;
  }
  bool path_violation = false;
  int root_fd = open_workspace_root(argv[2], &path_violation);
  if (root_fd < 0) return report_failure("path-helper", path_violation);
  atomic_entry *entries = calloc(count, sizeof(*entries));
  if (entries == NULL) {
    close(root_fd);
    return PATH_HELPER_IO_FAILURE;
  }
  for (size_t index = 0; index < count; index += 1) entries[index].parent_fd = -1;
  int result = PATH_HELPER_IO_FAILURE;
  for (size_t index = 0; index < count; index += 1) {
    const char *path = argv[4 + index * 2];
    if (parse_size(argv[5 + index * 2], &entries[index].length) != 0 ||
        open_parent_beneath(root_fd, path, &entries[index].parent_fd, &entries[index].leaf, &path_violation) != 0) {
      if (errno == ENOTDIR) path_violation = true;
      result = path_violation ? PATH_HELPER_PATH_VIOLATION : PATH_HELPER_IO_FAILURE;
      goto cleanup;
    }
  }
  if (pause_after_pinned_descriptor() != 0) goto cleanup;
  for (size_t index = 0; index < count; index += 1) {
    struct stat metadata;
    if (fstatat(entries[index].parent_fd, entries[index].leaf, &metadata, AT_SYMLINK_NOFOLLOW) == 0) {
      if (!S_ISREG(metadata.st_mode)) {
        result = PATH_HELPER_VALIDATION_FAILURE;
        goto cleanup;
      }
      entries[index].exists = true;
      entries[index].mode = metadata.st_mode & 07777;
      entries[index].device = metadata.st_dev;
      entries[index].inode = metadata.st_ino;
    } else if (errno != ENOENT) {
      if (is_path_violation_errno(errno)) result = PATH_HELPER_PATH_VIOLATION;
      goto cleanup;
    }
    for (size_t prior = 0; prior < index; prior += 1) {
      bool same_name = same_parent(entries[index].parent_fd, entries[prior].parent_fd) &&
          strcmp(entries[index].leaf, entries[prior].leaf) == 0;
      bool same_object = entries[index].exists && entries[prior].exists &&
          entries[index].device == entries[prior].device && entries[index].inode != 0 &&
          entries[index].inode == entries[prior].inode;
      if (same_name || same_object) {
        result = PATH_HELPER_VALIDATION_FAILURE;
        goto cleanup;
      }
    }
  }
  result = probe_absent_aliases(entries, count);
  if (result != 0) goto cleanup;
  for (size_t index = 0; index < count; index += 1) {
    (void)snprintf(entries[index].stage, sizeof(entries[index].stage), ".zapp-atomic-%ld-%zu.stage", (long)getpid(), index);
    (void)snprintf(entries[index].backup, sizeof(entries[index].backup), ".zapp-atomic-%ld-%zu.backup", (long)getpid(), index);
    int stage_fd = openat(entries[index].parent_fd, entries[index].stage, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, entries[index].exists ? entries[index].mode : 0666);
    if (stage_fd < 0) goto rollback;
    char buffer[64 * 1024];
    size_t remaining = entries[index].length;
    while (remaining > 0) {
      size_t chunk = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
      if (read_exact(STDIN_FILENO, buffer, chunk) != 0 || write_all(stage_fd, buffer, chunk) != 0) {
        close(stage_fd);
        goto rollback;
      }
      remaining -= chunk;
    }
    if (entries[index].exists && fchmod(stage_fd, entries[index].mode) != 0) {
      close(stage_fd);
      goto rollback;
    }
    close(stage_fd);
  }
  for (size_t index = 0; index < count; index += 1) {
    if (entries[index].exists) {
      if (renameat(entries[index].parent_fd, entries[index].leaf, entries[index].parent_fd, entries[index].backup) != 0) goto rollback;
      entries[index].backed_up = true;
    }
    const char *failure_index = getenv("ZAPP_NATIVE_TEST_FAIL_ATOMIC_COMMIT_INDEX");
    if (failure_index != NULL) {
      size_t parsed_failure_index = 0;
      if (parse_size(failure_index, &parsed_failure_index) == 0 && parsed_failure_index == index) {
        errno = EIO;
        goto rollback;
      }
    }
    if (renameat(entries[index].parent_fd, entries[index].stage, entries[index].parent_fd, entries[index].leaf) != 0) goto rollback;
    entries[index].committed = true;
  }
  result = 0;
  goto cleanup;

rollback:
  for (size_t reverse = count; reverse > 0; reverse -= 1) {
    atomic_entry *entry = &entries[reverse - 1];
    if (entry->committed) (void)unlinkat(entry->parent_fd, entry->leaf, 0);
    if (entry->backed_up) (void)renameat(entry->parent_fd, entry->backup, entry->parent_fd, entry->leaf);
  }
  result = PATH_HELPER_IO_FAILURE;

cleanup:
  for (size_t index = 0; index < count; index += 1) {
    if (entries[index].parent_fd >= 0) {
      if (entries[index].stage[0] != '\0') (void)unlinkat(entries[index].parent_fd, entries[index].stage, 0);
      if (entries[index].backup[0] != '\0') (void)unlinkat(entries[index].parent_fd, entries[index].backup, 0);
    }
  }
  close(root_fd);
  close_atomic_entries(entries, count);
  return result;
}

static int run_delete(const char *root, const char *path) {
  bool path_violation = false;
  int root_fd = open_workspace_root(root, &path_violation);
  int parent_fd = -1;
  char *leaf = NULL;
  if (root_fd < 0 || open_parent_beneath(root_fd, path, &parent_fd, &leaf, &path_violation) != 0 ||
      pause_after_pinned_descriptor() != 0) {
    int result = path_violation ? PATH_HELPER_PATH_VIOLATION : PATH_HELPER_IO_FAILURE;
    if (parent_fd >= 0) close(parent_fd);
    if (root_fd >= 0) close(root_fd);
    free(leaf);
    return result;
  }
  struct stat metadata;
  int result = 0;
  if (fstatat(parent_fd, leaf, &metadata, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) {
      (void)write_all(STDOUT_FILENO, "1", 1);
    } else {
      result = PATH_HELPER_IO_FAILURE;
    }
  } else if (!S_ISREG(metadata.st_mode)) {
    result = PATH_HELPER_VALIDATION_FAILURE;
  } else if (unlinkat(parent_fd, leaf, 0) != 0) {
    result = PATH_HELPER_IO_FAILURE;
  } else {
    (void)write_all(STDOUT_FILENO, "0", 1);
  }
  close(parent_fd);
  close(root_fd);
  free(leaf);
  return result;
}

static int run_rename(const char *root, const char *source, const char *destination) {
  bool path_violation = false;
  int root_fd = open_workspace_root(root, &path_violation);
  int source_parent = -1;
  int destination_parent = -1;
  char *source_leaf = NULL;
  char *destination_leaf = NULL;
  int result = PATH_HELPER_IO_FAILURE;
  if (root_fd < 0 ||
      open_parent_beneath(root_fd, source, &source_parent, &source_leaf, &path_violation) != 0 ||
      open_parent_beneath(root_fd, destination, &destination_parent, &destination_leaf, &path_violation) != 0 ||
      pause_after_pinned_descriptor() != 0) {
    result = path_violation ? PATH_HELPER_PATH_VIOLATION : PATH_HELPER_IO_FAILURE;
    goto rename_cleanup;
  }
  struct stat source_metadata;
  struct stat destination_metadata;
  if (fstatat(source_parent, source_leaf, &source_metadata, AT_SYMLINK_NOFOLLOW) != 0) goto rename_cleanup;
  if (!S_ISREG(source_metadata.st_mode)) {
    result = PATH_HELPER_VALIDATION_FAILURE;
    goto rename_cleanup;
  }
  bool destination_exists = fstatat(destination_parent, destination_leaf, &destination_metadata, AT_SYMLINK_NOFOLLOW) == 0;
  if (!destination_exists && errno != ENOENT) goto rename_cleanup;
  if (destination_exists && (!S_ISREG(destination_metadata.st_mode) ||
      (source_metadata.st_dev == destination_metadata.st_dev && source_metadata.st_ino != 0 && source_metadata.st_ino == destination_metadata.st_ino))) {
    result = PATH_HELPER_VALIDATION_FAILURE;
    goto rename_cleanup;
  }
  if (same_parent(source_parent, destination_parent) && strcmp(source_leaf, destination_leaf) == 0) {
    result = PATH_HELPER_VALIDATION_FAILURE;
    goto rename_cleanup;
  }
  if (renameat(source_parent, source_leaf, destination_parent, destination_leaf) == 0) result = 0;

rename_cleanup:
  if (source_parent >= 0) close(source_parent);
  if (destination_parent >= 0) close(destination_parent);
  if (root_fd >= 0) close(root_fd);
  free(source_leaf);
  free(destination_leaf);
  return result;
}

static int run_search(int argc, char **argv) {
  if (argc != 9) return PATH_HELPER_USAGE;
  bool path_violation = false;
  int root_fd = open_workspace_root(argv[2], &path_violation);
  int parent_fd = -1;
  int target_fd = -1;
  char *leaf = NULL;
  if (root_fd < 0 || open_parent_beneath(root_fd, argv[3], &parent_fd, &leaf, &path_violation) != 0 ||
      (target_fd = open_final_beneath(parent_fd, leaf, O_RDONLY, 0, &path_violation)) < 0 ||
      pause_after_pinned_descriptor() != 0) {
    if (target_fd >= 0) close(target_fd);
    if (parent_fd >= 0) close(parent_fd);
    if (root_fd >= 0) close(root_fd);
    free(leaf);
    return path_violation ? PATH_HELPER_PATH_VIOLATION : PATH_HELPER_IO_FAILURE;
  }
  (void)fcntl(target_fd, F_SETFD, 0);
  char descriptor_path[64];
  struct stat target_metadata;
  if (fstat(target_fd, &target_metadata) != 0) return PATH_HELPER_IO_FAILURE;
  if (S_ISDIR(target_metadata.st_mode)) {
    if (fchdir(target_fd) != 0) return PATH_HELPER_IO_FAILURE;
    (void)snprintf(descriptor_path, sizeof(descriptor_path), ".");
  } else {
#if defined(__linux__)
    (void)snprintf(descriptor_path, sizeof(descriptor_path), "/proc/self/fd/%d", target_fd);
#else
    (void)snprintf(descriptor_path, sizeof(descriptor_path), "/dev/fd/%d", target_fd);
#endif
  }
  char *arguments[16];
  size_t next = 0;
  arguments[next++] = argv[8];
  arguments[next++] = "--no-heading";
  arguments[next++] = "--line-number";
  arguments[next++] = "--color=never";
  if (argv[5][0] != '\0') {
    arguments[next++] = "--glob";
    arguments[next++] = argv[5];
  }
  if (strcmp(argv[6], "1") == 0) arguments[next++] = "--fixed-strings";
  if (strcmp(argv[7], "1") == 0) arguments[next++] = "--ignore-case";
  arguments[next++] = "--";
  arguments[next++] = argv[4];
  arguments[next++] = descriptor_path;
  arguments[next] = NULL;
  execv(argv[8], arguments);
  return PATH_HELPER_IO_FAILURE;
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
  if (argc >= 6 && strcmp(argv[1], "atomic-write") == 0) {
    return run_atomic_write(argc, argv);
  }
  if (argc == 4 && strcmp(argv[1], "delete") == 0) {
    return run_delete(argv[2], argv[3]);
  }
  if (argc == 5 && strcmp(argv[1], "rename") == 0) {
    return run_rename(argv[2], argv[3], argv[4]);
  }
  if (argc == 9 && strcmp(argv[1], "search") == 0) {
    return run_search(argc, argv);
  }
  (void)fprintf(stderr, "path-helper: invalid invocation\n");
  return PATH_HELPER_USAGE;
}

#ifndef PATH_HELPER_LIBRARY
int main(int argc, char **argv) {
  return path_helper_main(argc, argv);
}
#endif
