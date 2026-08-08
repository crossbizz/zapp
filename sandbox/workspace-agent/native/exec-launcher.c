#define PATH_HELPER_LIBRARY
#include "path-helper.c"

int main(int argc, char **argv) {
  if (argc < 7 || strcmp(argv[1], "--workspace-root") != 0 ||
      strcmp(argv[3], "--cwd") != 0) {
    (void)fprintf(stderr, "exec-launcher: invalid invocation\n");
    return PATH_HELPER_USAGE;
  }

  int command_index = 5;
  const char *cgroup_procs = NULL;
  if (command_index + 1 < argc && strcmp(argv[command_index], "--cgroup-procs") == 0) {
    cgroup_procs = argv[command_index + 1];
    command_index += 2;
  }
  if (command_index + 1 >= argc || strcmp(argv[command_index], "--") != 0) {
    (void)fprintf(stderr, "exec-launcher: invalid invocation\n");
    return PATH_HELPER_USAGE;
  }

  bool path_violation = false;
  int root_fd = open_workspace_root(argv[2], &path_violation);
  int cwd_fd = -1;
  if (root_fd < 0 ||
      (cwd_fd = open_directory_beneath(root_fd, argv[4], &path_violation)) < 0) {
    if (cwd_fd >= 0) close(cwd_fd);
    if (root_fd >= 0) close(root_fd);
    return report_failure("exec-launcher", path_violation);
  }
  if (cgroup_procs != NULL && join_cgroup(cgroup_procs) != 0) {
    close(cwd_fd);
    close(root_fd);
    return report_containment_failure("exec-launcher");
  }
  if (pause_after_pinned_descriptor() != 0 || fchdir(cwd_fd) != 0) {
    close(cwd_fd);
    close(root_fd);
    return report_failure("exec-launcher", false);
  }
  close(cwd_fd);
  close(root_fd);

  execvp(argv[command_index + 1], &argv[command_index + 1]);
  return report_failure("exec-launcher", false);
}
