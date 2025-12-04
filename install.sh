#!/bin/bash
#
# TermStation Interactive Installer
# Supports: Ubuntu 22.04+ (with Docker) and Rocky Linux 10+ (with Podman)
#
# These instructions assume a fresh OS installation, but that is not required.
# If installing on an existing system, review this script carefully before running.
#
# This installer modifies system packages, creates users, and configures services.
# Run at your own risk.
#
# See INSTALL.md for more information.
#

set -euo pipefail

# Trap errors and provide useful output
trap 'error_handler $? $LINENO $BASH_LINENO "$BASH_COMMAND" $(printf "::%s" ${FUNCNAME[@]:-})' ERR

# Trap Ctrl+C and exit immediately
trap 'echo -e "\n\033[0;31mInstallation cancelled.\033[0m"; exit 130' INT

error_handler() {
    local exit_code=$1
    local line_no=$2
    local bash_lineno=$3
    local last_command=$4
    local func_trace=$5
    echo -e "\n${RED}${BOLD}ERROR: Installation failed!${NC}"
    echo -e "${RED}Exit code: $exit_code${NC}"
    echo -e "${RED}Line: $line_no${NC}"
    echo -e "${RED}Command: $last_command${NC}"
    echo -e "${RED}Function trace: $func_trace${NC}"
    exit "$exit_code"
}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Defaults
DEFAULT_SERVICE_USER="termstation"
DEFAULT_BIND_ADDRESS="127.0.0.1"
DEFAULT_BACKEND_PORT=6624
DEFAULT_FRONTEND_PORT=6625
DEFAULT_GIT_NAME="TermStation Agent"
DEFAULT_GIT_EMAIL="termstation@localhost"

# Install log file
INSTALL_LOG=""

# Repository root (directory containing this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# State
CREATE_SERVICE_USER=false
SERVICE_USER=""
SERVICE_USER_HOME=""
INSTALL_DIR="/opt/termstation"
UPGRADE_MODE=false
UPGRADE_REINSTALL_DEPS=false
CONFIG_DIR=""
DATA_DIR=""
BIND_ADDRESS=""
BACKEND_PORT=""
FRONTEND_PORT=""
GIT_NAME=""
GIT_EMAIL=""
USE_EXISTING_GITCONFIG=false
GITCONFIG_PATH=""
FORGE_GITHUB=true
FORGE_GITLAB=false
FORGE_GITEA=false
GENERATE_SSH_KEY=false
SSH_KEY_NAME=""
SSH_CONFIG_PATH=""
MOUNT_GH_CONFIG=false   # Bind mount ~/.config/gh/ for GitHub CLI
MOUNT_GLAB_CONFIG=false # Bind mount ~/.config/glab-cli/ for GitLab CLI
MOUNT_TEA_CONFIG=false  # Bind mount ~/.config/tea/ for Gitea CLI
BASH_SHELL_MODE=""  # "self", "service", or "none"
SHELL_USER=""
TERMSTATION_LOGIN=""  # The login username for TermStation web UI
CONTAINER_RUNTIME="podman"
BUILD_CONTAINER=true
INSTALL_CHAT_TO_HTML=false
INSTALL_PTY_TO_HTML=false
INSTALL_SELINUX_POLICY=true
INSTALL_HOST_AI_CLIS=true

# OS Detection
OS_TYPE=""  # "ubuntu" or "rocky"
PKG_MANAGER=""  # "apt" or "dnf"

detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        case "$ID" in
            ubuntu|debian)
                OS_TYPE="ubuntu"
                PKG_MANAGER="apt"
                # Default to docker on Ubuntu
                CONTAINER_RUNTIME="docker"
                # SELinux is typically not enforcing on Ubuntu
                INSTALL_SELINUX_POLICY=false
                ;;
            rocky|rhel|centos|almalinux|fedora)
                OS_TYPE="rocky"
                PKG_MANAGER="dnf"
                CONTAINER_RUNTIME="podman"
                ;;
            *)
                die "Unsupported OS: $ID. This installer supports Ubuntu/Debian and Rocky/RHEL/CentOS/AlmaLinux/Fedora."
                ;;
        esac
    else
        die "Cannot detect OS: /etc/os-release not found"
    fi
}

# Logging
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

log_step() {
    echo -e "\n${BLUE}${BOLD}==> $1${NC}"
}

# Log a command to the install log file
log_cmd() {
    if [[ -n "$INSTALL_LOG" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] CMD: $*" >> "$INSTALL_LOG"
    fi
}

# Log command output to the install log file
log_output() {
    if [[ -n "$INSTALL_LOG" ]]; then
        while IFS= read -r line; do
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] OUT: $line" >> "$INSTALL_LOG"
        done
    fi
}

# Run a command and log it with output capture
run_cmd() {
    log_cmd "$@"
    local output
    local exit_code=0
    output=$("$@" 2>&1) || exit_code=$?
    if [[ -n "$output" ]]; then
        echo "$output" | log_output
        echo "$output"
    fi
    if [[ -n "$INSTALL_LOG" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] EXIT: $exit_code" >> "$INSTALL_LOG"
    fi
    return $exit_code
}

# Run a command with sudo and log it
run_sudo() {
    log_cmd "sudo $*"
    local output
    local exit_code=0
    output=$(sudo "$@" 2>&1) || exit_code=$?
    if [[ -n "$output" ]]; then
        echo "$output" | log_output
        echo "$output"
    fi
    if [[ -n "$INSTALL_LOG" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] EXIT: $exit_code" >> "$INSTALL_LOG"
    fi
    return $exit_code
}

# Exit with error message
die() {
    log_error "$1"
    exit "${2:-1}"
}

# Menu helpers
print_header() {
    clear
    echo -e "${CYAN}${BOLD}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║           TermStation Interactive Installer               ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

prompt_input() {
    local prompt="$1"
    local default="$2"
    local varname="$3"

    if [ -n "$default" ]; then
        echo -ne "${BOLD}$prompt${NC} [${CYAN}$default${NC}]: "
    else
        echo -ne "${BOLD}$prompt${NC}: "
    fi

    read -r input
    if [ -z "$input" ] && [ -n "$default" ]; then
        eval "$varname=\"$default\""
    else
        eval "$varname=\"$input\""
    fi
}

prompt_yes_no() {
    local prompt="$1"
    local default="$2"  # y or n
    local varname="$3"

    local yn_hint="[y/n]"
    if [ "$default" = "y" ]; then
        yn_hint="[Y/n]"
    elif [ "$default" = "n" ]; then
        yn_hint="[y/N]"
    fi

    echo -ne "${BOLD}$prompt${NC} $yn_hint: "
    read -r input

    input=$(echo "$input" | tr '[:upper:]' '[:lower:]')
    if [ -z "$input" ]; then
        input="$default"
    fi

    if [ "$input" = "y" ] || [ "$input" = "yes" ]; then
        eval "$varname=true"
    else
        eval "$varname=false"
    fi
}

press_enter() {
    echo -e "\n${YELLOW}Press Enter to continue...${NC}"
    read -r
}

# Run command as service user
run_as_service_user() {
    local cmd="$1"
    local rc=0
    if $CREATE_SERVICE_USER; then
        log_cmd "sudo -u $SERVICE_USER -i bash -c \"$cmd\""
        sudo -u "$SERVICE_USER" -i bash -c "PATH=\"\$PATH:/usr/local/bin\"; $cmd" 2>&1 | tee -a "${INSTALL_LOG:-/dev/null}" || rc=${PIPESTATUS[0]}
    else
        log_cmd "eval \"$cmd\""
        eval "$cmd" 2>&1 | tee -a "${INSTALL_LOG:-/dev/null}" || rc=${PIPESTATUS[0]}
    fi
    if [[ -n "${INSTALL_LOG:-}" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] EXIT: $rc" >> "$INSTALL_LOG"
    fi
    if [ $rc -ne 0 ]; then
        die "Command failed with exit code $rc: $cmd"
    fi
    return 0
}

# Run command as service user with TTY (for interactive commands)
# Returns the exit code but doesn't die on failure (for optional auth)
run_as_service_user_interactive() {
    local rc=0
    if $CREATE_SERVICE_USER; then
        log_cmd "sudo -u $SERVICE_USER -i (interactive) $*"
        sudo -u "$SERVICE_USER" -i env "PATH=$PATH:/usr/local/bin" "$@" || rc=$?
    else
        log_cmd "(interactive) $*"
        "$@" || rc=$?
    fi
    if [[ -n "${INSTALL_LOG:-}" ]]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] EXIT: $rc" >> "$INSTALL_LOG"
    fi
    return $rc
}

# Menu: Service User
menu_service_user() {
    print_header
    echo -e "${BOLD}Service User Configuration${NC}\n"

    echo -e "Detected OS: ${CYAN}$OS_TYPE${NC} (using ${CYAN}$PKG_MANAGER${NC})\n"

    echo -e "You can run TermStation as your current user or create a dedicated"
    echo -e "service user. A service user is recommended for production deployments.\n"

    prompt_yes_no "Create a dedicated service user" "n" "CREATE_SERVICE_USER"

    if $CREATE_SERVICE_USER; then
        prompt_input "Service user name" "$DEFAULT_SERVICE_USER" "SERVICE_USER"
        SERVICE_USER_HOME="/home/$SERVICE_USER"
    else
        SERVICE_USER=$(whoami)
        SERVICE_USER_HOME="$HOME"
    fi

    # XDG-style directories for config and data
    CONFIG_DIR="$SERVICE_USER_HOME/.config/termstation"
    DATA_DIR="$SERVICE_USER_HOME/.local/share/termstation"
}

# Menu: Basic Configuration
menu_basic_config() {
    print_header
    echo -e "${BOLD}Basic Configuration${NC}\n"

    if $CREATE_SERVICE_USER; then
        echo -e "Service user: ${CYAN}$SERVICE_USER${NC}"
        echo -e "Home directory: ${CYAN}$SERVICE_USER_HOME${NC}\n"
    fi

    prompt_input "Config directory" "$CONFIG_DIR" "CONFIG_DIR"
    prompt_input "Data directory" "$DATA_DIR" "DATA_DIR"

    echo -e "\n${BOLD}Network Configuration${NC}"
    echo -e "  1) 127.0.0.1 (localhost only - use SSH tunnel for remote access)"
    echo -e "  2) 0.0.0.0 (all interfaces - recommended for local LAN only)\n"
    local bind_choice=""
    while :; do
        prompt_input "Bind address (1 or 2)" "1" "bind_choice"
        case "$bind_choice" in
            1)
                BIND_ADDRESS="127.0.0.1"
                break
                ;;
            2)
                BIND_ADDRESS="0.0.0.0"
                break
                ;;
            *)
                echo -e "${RED}Invalid selection. Please enter 1 or 2.${NC}"
                ;;
        esac
    done

    prompt_input "Backend port" "$DEFAULT_BACKEND_PORT" "BACKEND_PORT"
    prompt_input "Frontend port" "$DEFAULT_FRONTEND_PORT" "FRONTEND_PORT"
}

# Early: Select install location and offer upgrade before service user prompts
menu_install_location() {
    print_header
    echo -e "${BOLD}Install Location${NC}\n"
    prompt_input "App install directory" "$INSTALL_DIR" "INSTALL_DIR"

    # If install dir already exists and appears to be a TermStation install,
    # offer Upgrade/Reinstall/Cancel immediately (before service user prompts).
    if [ -d "$INSTALL_DIR/backend" ] || [ -f "$INSTALL_DIR/backend/start.sh" ]; then
        echo ""
        echo -e "${YELLOW}Existing TermStation installation detected at:${NC} ${CYAN}$INSTALL_DIR${NC}\n"
        echo -e "Choose an action:\n"
        echo -e "  1) ${GREEN}Upgrade${NC} (update app code and dependencies; keep config and Dockerfile)"
        echo -e "  2) ${RED}Reinstall (fresh)${NC} (run full installer)"
        echo -e "  3) Cancel\n"

        local upgrade_choice=""
        prompt_input "Select option" "1" "upgrade_choice"
        case "$upgrade_choice" in
            1)
                UPGRADE_MODE=true
                populate_from_existing_install || true
                menu_upgrade_summary
                # Initialize install log for upgrade
                INSTALL_LOG="$(pwd)/termstation-install.log"
                mkdir -p "$(dirname "$INSTALL_LOG")"
                echo "=== TermStation Installation Log (Upgrade) ===" > "$INSTALL_LOG"
                echo "Started: $(date)" >> "$INSTALL_LOG"
                echo "User: $(whoami)" >> "$INSTALL_LOG"
                echo "Host: $(hostname)" >> "$INSTALL_LOG"
                echo "" >> "$INSTALL_LOG"
                log_info "Installation log: $INSTALL_LOG"
                upgrade_termstation
                if [ "$INSTALL_CHAT_TO_HTML" = "true" ] || [ "$INSTALL_PTY_TO_HTML" = "true" ]; then
                    build_optional_dependencies
                fi
                print_upgrade_completion
                exit 0
                ;;
            2)
                UPGRADE_MODE=false
                ;;
            3)
                echo -e "\n${RED}Installation cancelled.${NC}"
                exit 0
                ;;
            *)
                UPGRADE_MODE=true
                populate_from_existing_install || true
                menu_upgrade_summary
                INSTALL_LOG="$(pwd)/termstation-install.log"
                mkdir -p "$(dirname "$INSTALL_LOG")"
                echo "=== TermStation Installation Log (Upgrade) ===" > "$INSTALL_LOG"
                echo "Started: $(date)" >> "$INSTALL_LOG"
                echo "User: $(whoami)" >> "$INSTALL_LOG"
                echo "Host: $(hostname)" >> "$INSTALL_LOG"
                echo "" >> "$INSTALL_LOG"
                log_info "Installation log: $INSTALL_LOG"
                upgrade_termstation
                if [ "$INSTALL_CHAT_TO_HTML" = "true" ] || [ "$INSTALL_PTY_TO_HTML" = "true" ]; then
                    build_optional_dependencies
                fi
                print_upgrade_completion
                exit 0
                ;;
        esac
    fi
}

# Read existing config from start scripts to populate summary fields for upgrade mode
populate_from_existing_install() {
    local backend_start="$INSTALL_DIR/backend/start.sh"
    local frontend_start="$INSTALL_DIR/frontend/start.sh"
    # Pull config dir and backend bind/port from backend start script
    if [ -f "$backend_start" ]; then
        local v
        v=$(grep -E '^export\s+TERMSTATION_CONFIG_DIR=' "$backend_start" 2>/dev/null | head -1 | sed -E 's/^export\s+TERMSTATION_CONFIG_DIR=\"?(.*)\"?/\1/')
        if [ -n "${v:-}" ]; then CONFIG_DIR="$v"; fi
        v=$(grep -E '^export\s+TERMSTATION_BACKEND_BIND_ADDRESS=' "$backend_start" 2>/dev/null | head -1 | sed -E 's/^export\s+TERMSTATION_BACKEND_BIND_ADDRESS=\"?(.*)\"?/\1/')
        if [ -n "${v:-}" ]; then BIND_ADDRESS="$v"; fi
        v=$(grep -E '^export\s+TERMSTATION_BACKEND_PORT=' "$backend_start" 2>/dev/null | head -1 | sed -E 's/^export\s+TERMSTATION_BACKEND_PORT=\"?(.*)\"?/\1/')
        if [ -n "${v:-}" ]; then BACKEND_PORT="$v"; fi
    fi
    # Pull frontend bind/port
    if [ -f "$frontend_start" ]; then
        local v
        v=$(grep -E '^export\s+TERMSTATION_FRONTEND_BIND_ADDRESS=' "$frontend_start" 2>/dev/null | head -1 | sed -E 's/^export\s+TERMSTATION_FRONTEND_BIND_ADDRESS=\"?(.*)\"?/\1/')
        # Frontend start template does not carry bind address yet; ignore if empty
        if [ -n "${v:-}" ]; then :; fi
        v=$(grep -E '^export\s+TERMSTATION_FRONTEND_PORT=' "$frontend_start" 2>/dev/null | head -1 | sed -E 's/^export\s+TERMSTATION_FRONTEND_PORT=\"?(.*)\"?/\1/')
        if [ -n "${v:-}" ]; then FRONTEND_PORT="$v"; fi
    fi
}

# Minimal summary for upgrade mode with optional container rebuild prompt
menu_upgrade_summary() {
    print_header
    echo -e "${BOLD}Upgrade Summary${NC}\n"
    echo -e "  ${BOLD}Install dir:${NC}       $INSTALL_DIR"
    echo ""
    echo -e "This will:${NC}"
    echo -e "  - Update application files (backend, frontend, shared)"
    echo -e "  - Optionally re-install npm dependencies and rebuild backend tools"
    echo -e "  - Leave config, data, start scripts, and Dockerfile untouched"
    echo -e "  - Skip system packages, SELinux policies, SSH, forge config, templates, and interpolation"
    echo -e "  - Optionally update external helpers (chat-to-html, pty-to-html)\n"

    # External helpers (optional)
    prompt_yes_no "Build/update chat-to-html helper" "n" "INSTALL_CHAT_TO_HTML"
    prompt_yes_no "Build/update pty-to-html helper" "n" "INSTALL_PTY_TO_HTML"
    echo ""
    local PROCEED_UPGRADE=false
    prompt_yes_no "Proceed with upgrade" "y" "PROCEED_UPGRADE"
    if [ "$PROCEED_UPGRADE" != "true" ]; then
        echo -e "\n${RED}Upgrade cancelled.${NC}"
        exit 0
    fi
}

# Perform in-place upgrade of app files and dependencies only
upgrade_termstation() {
    log_step "Upgrading TermStation application files"

    # Verify repo structure exists
    if [ ! -d "$SCRIPT_DIR/backend" ] || [ ! -d "$SCRIPT_DIR/frontend" ] || [ ! -d "$SCRIPT_DIR/shared" ]; then
        die "This script must be run from the termstation repository root. Missing backend/, frontend/, or shared/ directory in: $SCRIPT_DIR"
    fi

    # Ensure install dir exists
    if ! sudo mkdir -p "$INSTALL_DIR" 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to ensure install directory"
    fi

    # Use rsync to update and remove stale files
    log_info "Syncing backend/ frontend/ shared/ to $INSTALL_DIR (rsync --delete)"
    if ! command -v rsync >/dev/null 2>&1; then
        log_warn "rsync not found; falling back to cp -r (stale files may remain)"
        sudo cp -r "$SCRIPT_DIR/backend" "$INSTALL_DIR/" 2>&1 | tee -a "$INSTALL_LOG" || die "Failed to copy backend"
        sudo cp -r "$SCRIPT_DIR/frontend" "$INSTALL_DIR/" 2>&1 | tee -a "$INSTALL_LOG" || die "Failed to copy frontend"
        sudo cp -r "$SCRIPT_DIR/shared" "$INSTALL_DIR/" 2>&1 | tee -a "$INSTALL_LOG" || die "Failed to copy shared"
    else
        sudo rsync -a --delete "$SCRIPT_DIR/backend/" "$INSTALL_DIR/backend/" 2>&1 | tee -a "$INSTALL_LOG" || die "Failed to sync backend"
        sudo rsync -a --delete "$SCRIPT_DIR/frontend/" "$INSTALL_DIR/frontend/" 2>&1 | tee -a "$INSTALL_LOG" || die "Failed to sync frontend"
        sudo rsync -a --delete "$SCRIPT_DIR/shared/" "$INSTALL_DIR/shared/" 2>&1 | tee -a "$INSTALL_LOG" || die "Failed to sync shared"
    fi

    # Fix permissions
    sudo chmod -R a+rX "$INSTALL_DIR" 2>&1 | tee -a "$INSTALL_LOG" || true

    # Always re-install deps and rebuild backend tools (backend)
    log_info "Installing frontend dependencies..."
    (cd "$INSTALL_DIR/frontend" && sudo npm install 2>&1 | tee -a "$INSTALL_LOG") || die "Failed to install frontend dependencies"
    log_info "Installing backend dependencies..."
    (cd "$INSTALL_DIR/backend" && sudo npm install 2>&1 | tee -a "$INSTALL_LOG") || die "Failed to install backend dependencies"
    log_info "Building backend tools..."
    local bun_path="$HOME/.bun/bin"
    (cd "$INSTALL_DIR/backend" && sudo PATH="$bun_path:$PATH" npm run build 2>&1 | tee -a "$INSTALL_LOG") || die "Failed to build backend tools"

    log_info "Upgrade of application files complete"
}

print_upgrade_completion() {
    print_header
    echo -e "${GREEN}${BOLD}Upgrade Complete!${NC}\n"
    echo -e "${BOLD}Summary:${NC}\n"
    echo -e "  ${BOLD}App install dir:${NC}   $INSTALL_DIR"
    echo ""
    echo -e "${BOLD}Next Steps:${NC}\n"
    echo -e "${YELLOW}Note:${NC} If the backend or frontend are currently running, stop them before restarting."
    echo -e "      For example: press Ctrl+C in the terminal where they run,"
    echo -e "      or stop any service/supervisor that launched them.\n"
    echo -e "1. Start the backend:"
    echo -e "   ${CYAN}$INSTALL_DIR/backend/start.sh${NC}\n"
    echo -e "2. Start the frontend (another terminal):"
    echo -e "   ${CYAN}$INSTALL_DIR/frontend/start.sh${NC}\n"
    if [ -n "$CONFIG_DIR" ]; then
        echo -e "3. Rebuild container later if needed:"
        echo -e "   ${CYAN}$CONTAINER_RUNTIME build -f $CONFIG_DIR/Dockerfile -t termstation $CONFIG_DIR${NC}\n"
    fi
}

# Menu: Git Configuration
menu_git_config() {
    print_header
    echo -e "${BOLD}Git Configuration${NC}\n"
    echo -e "These settings are used for commits made by TermStation agents.\n"

    # Check if user has existing gitconfig
    local existing_gitconfig="$HOME/.gitconfig"
    local existing_name=""
    local existing_email=""

    if [ -f "$existing_gitconfig" ]; then
        existing_name=$(git config --global user.name 2>/dev/null || true)
        existing_email=$(git config --global user.email 2>/dev/null || true)
    fi

    USE_EXISTING_GITCONFIG=false
    if [ -n "$existing_name" ] && [ -n "$existing_email" ]; then
        echo -e "Found existing Git configuration:"
        echo -e "  Name:  ${CYAN}$existing_name${NC}"
        echo -e "  Email: ${CYAN}$existing_email${NC}\n"

        prompt_yes_no "Use existing Git configuration" "y" "USE_EXISTING_GITCONFIG"

        if $USE_EXISTING_GITCONFIG; then
            GIT_NAME="$existing_name"
            GIT_EMAIL="$existing_email"
            GITCONFIG_PATH="$existing_gitconfig"
            if $CREATE_SERVICE_USER; then
                echo -e "\n${YELLOW}Note: ~/.gitconfig will be copied to the service user's home directory"
                echo -e "      and written into container sessions.${NC}\n"
            else
                echo -e "\n${YELLOW}Note: ~/.gitconfig will be written into container sessions.${NC}\n"
            fi
            return
        fi
        echo ""
    fi

    echo -e "Enter Git identity for TermStation agents:\n"
    prompt_input "Git author name" "$DEFAULT_GIT_NAME" "GIT_NAME"
    prompt_input "Git author email" "$DEFAULT_GIT_EMAIL" "GIT_EMAIL"
    GITCONFIG_PATH=""  # Will be created during installation
}

# Menu: Code Forge Selection
menu_forge_selection() {
    print_header
    echo -e "${BOLD}Code Forge Selection${NC}\n"
    echo -e "Select which code forges to enable. GitHub is recommended.\n"

    prompt_yes_no "Enable GitHub" "y" "FORGE_GITHUB"
    prompt_yes_no "Enable GitLab" "n" "FORGE_GITLAB"
    prompt_yes_no "Enable Gitea" "n" "FORGE_GITEA"
}

# Menu: SSH Key Selection
menu_ssh_key() {
    print_header
    echo -e "${BOLD}SSH Key Configuration${NC}\n"
    echo -e "Which SSH key do you want to use for repository access?\n"

    # Find existing SSH keys in current user's .ssh directory
    local ssh_dir="$HOME/.ssh"
    local keys=()
    local key_names=()

    if [ -d "$ssh_dir" ]; then
        # Find private keys (files without .pub extension that have a matching .pub file)
        while IFS= read -r -d '' pubfile; do
            local privfile="${pubfile%.pub}"
            if [ -f "$privfile" ]; then
                local keyname
                keyname=$(basename "$privfile")
                keys+=("$privfile")
                key_names+=("$keyname")
            fi
        done < <(find "$ssh_dir" -maxdepth 1 -name "*.pub" -print0 2>/dev/null)
    fi

    # Build menu options
    local option_num=1
    echo -e "  ${BOLD}Available keys:${NC}"

    for i in "${!key_names[@]}"; do
        echo -e "  $option_num) ${CYAN}${key_names[$i]}${NC} (${keys[$i]})"
        ((option_num++))
    done

    local generate_option=$option_num
    echo -e "  $generate_option) ${GREEN}Generate a new SSH keypair${NC}"
    ((option_num++))

    local none_option=$option_num
    echo -e "  $none_option) \033[0;90mNone (skip SSH key configuration)\033[0m"
    echo ""

    if $CREATE_SERVICE_USER; then
        echo -e "${YELLOW}Note: The selected key will be copied to the service user's ~/.ssh directory"
        echo -e "      and bind mounted into container sessions.${NC}\n"
    else
        echo -e "${YELLOW}Note: The selected key will be bind mounted into container sessions.${NC}\n"
    fi

    local default_choice="$generate_option"
    # If termstation key exists, default to it
    for i in "${!key_names[@]}"; do
        if [ "${key_names[$i]}" = "termstation" ]; then
            default_choice=$((i + 1))
            break
        fi
    done

    local ssh_choice=""
    prompt_input "Select option" "$default_choice" "ssh_choice"

    if [ "$ssh_choice" = "$none_option" ]; then
        # None selected - skip SSH configuration
        GENERATE_SSH_KEY=false
        SSH_KEY_PATH=""
        SSH_KEY_NAME=""
        log_info "SSH key configuration skipped"
    elif [ "$ssh_choice" = "$generate_option" ]; then
        # Generate new key
        GENERATE_SSH_KEY=true
        SSH_KEY_NAME="termstation"
        SSH_KEY_PATH="$HOME/.ssh/termstation"
        log_info "Will generate new SSH key: $SSH_KEY_PATH"
    else
        # Existing key selected
        local idx=$((ssh_choice - 1))
        if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#keys[@]}" ]; then
            GENERATE_SSH_KEY=false
            SSH_KEY_PATH="${keys[$idx]}"
            SSH_KEY_NAME="${key_names[$idx]}"
            log_info "Using existing SSH key: $SSH_KEY_PATH"
        else
            # Invalid selection, default to generate
            log_warn "Invalid selection, defaulting to generate new key"
            GENERATE_SSH_KEY=true
            SSH_KEY_NAME="termstation"
            SSH_KEY_PATH="$HOME/.ssh/termstation"
        fi
    fi

    # Check for existing SSH config
    echo ""
    local existing_ssh_config="$HOME/.ssh/config"
    if [ -f "$existing_ssh_config" ]; then
        echo -e "Found existing SSH config: ${CYAN}$existing_ssh_config${NC}"
        local use_ssh_config=false
        prompt_yes_no "Use existing SSH config for container sessions" "y" "use_ssh_config"
        if $use_ssh_config; then
            SSH_CONFIG_PATH="$existing_ssh_config"
            if $CREATE_SERVICE_USER; then
                echo -e "${YELLOW}Note: ~/.ssh/config will be copied to the service user's ~/.ssh directory"
                echo -e "      and bind mounted into container sessions.${NC}"
            else
                echo -e "${YELLOW}Note: ~/.ssh/config will be bind mounted into container sessions.${NC}"
            fi
        else
            SSH_CONFIG_PATH=""
        fi
    else
        SSH_CONFIG_PATH=""
    fi
}

# Menu: Forge CLI Config Bind Mounts
menu_forge_auth() {
    print_header
    echo -e "${BOLD}Code Forge CLI Configuration${NC}\n"
    echo -e "Bind mount forge CLI configs into container sessions so agents can"
    echo -e "interact with your repositories (create PRs, issues, etc).\n"

    if $FORGE_GITHUB; then
        local gh_config_dir="$HOME/.config/gh"
        if [ -d "$gh_config_dir" ]; then
            echo -e "Found GitHub CLI config: ${CYAN}$gh_config_dir${NC}"
        else
            echo -e "${YELLOW}GitHub CLI config not found yet${NC}"
            echo -e "  Authenticate after install with: ${CYAN}gh auth login${NC}"
        fi
        prompt_yes_no "Bind mount GitHub CLI config into containers" "y" "MOUNT_GH_CONFIG"
        echo ""
    fi

    if $FORGE_GITLAB; then
        local glab_config_dir="$HOME/.config/glab-cli"
        if [ -d "$glab_config_dir" ]; then
            echo -e "Found GitLab CLI config: ${CYAN}$glab_config_dir${NC}"
        else
            echo -e "${YELLOW}GitLab CLI config not found yet${NC}"
            echo -e "  Authenticate after install with: ${CYAN}glab auth login${NC}"
        fi
        prompt_yes_no "Bind mount GitLab CLI config into containers" "y" "MOUNT_GLAB_CONFIG"
        echo ""
    fi

    if $FORGE_GITEA; then
        local tea_config_dir="$HOME/.config/tea"
        if [ -d "$tea_config_dir" ]; then
            echo -e "Found Gitea CLI config: ${CYAN}$tea_config_dir${NC}"
        else
            echo -e "${YELLOW}Gitea CLI config not found yet${NC}"
            echo -e "  Authenticate after install with: ${CYAN}tea login add${NC}"
        fi
        prompt_yes_no "Bind mount Gitea CLI config into containers" "y" "MOUNT_TEA_CONFIG"
        echo ""
    fi
}

# Menu: User Shell Access
menu_user_shells() {
    print_header
    echo -e "${BOLD}Bash Shell Template${NC}\n"
    echo -e "TermStation can provide a Bash shell template for authenticated users."
    echo -e "Choose which user the shell should run as:\n"

    local current_user
    current_user=$(whoami)

    echo -e "  1) ${CYAN}$current_user${NC} (your user account)"
    if $CREATE_SERVICE_USER; then
        echo -e "  2) ${CYAN}$SERVICE_USER${NC} (service user)"
        echo -e "  3) \033[0;90mNone (remove Bash template)\033[0m"
        echo ""
        echo -e "${YELLOW}Note: Running as '$current_user' requires a sudoers entry for the service user.${NC}\n"
    else
        echo -e "  2) \033[0;90mNone (remove Bash template)\033[0m"
        echo ""
    fi

    local shell_choice=""
    prompt_input "Select option" "1" "shell_choice"

    if $CREATE_SERVICE_USER; then
        case "$shell_choice" in
            1)
                BASH_SHELL_MODE="self"
                SHELL_USER="$current_user"
                log_info "Bash shell will run as $SHELL_USER (requires sudoers entry)"
                ;;
            2)
                BASH_SHELL_MODE="service"
                SHELL_USER="$SERVICE_USER"
                log_info "Bash shell will run as service user $SHELL_USER"
                ;;
            3)
                BASH_SHELL_MODE="none"
                SHELL_USER=""
                log_info "Bash template will be removed"
                ;;
            *)
                BASH_SHELL_MODE="self"
                SHELL_USER="$current_user"
                log_warn "Invalid selection, defaulting to $current_user"
                ;;
        esac
    else
        case "$shell_choice" in
            1)
                BASH_SHELL_MODE="self"
                SHELL_USER="$current_user"
                log_info "Bash shell will run as $SHELL_USER"
                ;;
            2)
                BASH_SHELL_MODE="none"
                SHELL_USER=""
                log_info "Bash template will be removed"
                ;;
            *)
                BASH_SHELL_MODE="self"
                SHELL_USER="$current_user"
                log_warn "Invalid selection, defaulting to $current_user"
                ;;
        esac
    fi

    # Ask for TermStation login name
    echo ""
    echo -e "${BOLD}TermStation Login${NC}\n"
    echo -e "Enter the username you want to use to log into TermStation web UI.\n"
    prompt_input "TermStation login name" "$current_user" "TERMSTATION_LOGIN"
}

# Menu: Optional Dependencies
menu_optional_dependencies() {
    print_header
    echo -e "${BOLD}Optional Dependencies${NC}\n"
    echo -e "You can install additional helpers used by TermStation:\n"
    echo -e "  - ${BOLD}chat-to-html${NC}: renders chat logs as HTML for the Chat Log tab."
    echo -e "  - ${BOLD}pty-to-html${NC}: renders terminal history as HTML for ended sessions."
    echo -e "    ${YELLOW}Note: Requires Zig 0.15.2. Will install to /opt/zig and overwrite any existing Zig there.${NC}"
    echo -e "  - ${BOLD}Host AI CLIs${NC}: installs Codex, Claude Code, and Cursor on this host for direct use.\n"

    prompt_yes_no "Install chat-to-html (recommended)" "y" "INSTALL_CHAT_TO_HTML"
    prompt_yes_no "Install pty-to-html (recommended)" "y" "INSTALL_PTY_TO_HTML"
    prompt_yes_no "Install host AI CLI tools (Claude, Codex, Cursor)" "y" "INSTALL_HOST_AI_CLIS"
}

# Menu: Container Image
menu_container() {
    print_header
    echo -e "${BOLD}Container Configuration${NC}\n"
    echo -e "TermStation uses containers for isolated agent sessions."
    echo -e "A Dockerfile will be generated with your selected forges.\n"

    echo -e "${BOLD}Container Runtime${NC}"
    # Ubuntu uses Docker only; Rocky/RHEL offers choice with Podman as default
    if [ "$OS_TYPE" = "ubuntu" ]; then
        echo -e "Using Docker (standard for Ubuntu/Debian)"
        CONTAINER_RUNTIME="docker"
        echo -e "Container runtime: ${CYAN}$CONTAINER_RUNTIME${NC}\n"
    else
        echo -e "  1) podman (recommended for Rocky/RHEL)"
        echo -e "  2) docker\n"
        local runtime_choice=""
        while :; do
            prompt_input "Container runtime (1 or 2)" "1" "runtime_choice"
            case "$runtime_choice" in
                1)
                    CONTAINER_RUNTIME="podman"
                    break
                    ;;
                2)
                    CONTAINER_RUNTIME="docker"
                    break
                    ;;
                *)
                    echo -e "${RED}Invalid selection. Please enter 1 or 2.${NC}"
                    ;;
            esac
        done
        echo -e "Container runtime: ${CYAN}$CONTAINER_RUNTIME${NC}\n"
    fi

    prompt_yes_no "Build container image during installation" "y" "BUILD_CONTAINER"

    # Only show SELinux option on systems that typically use it
    if [ "$OS_TYPE" = "rocky" ]; then
        echo -e "\n${BOLD}SELinux Policy (optional, recommended on SELinux-enforcing systems)${NC}\n"
        echo -e "TermStation uses a Unix domain socket for container sessions to talk to the backend API."
        echo -e "On SELinux-enforcing systems, a small policy module is needed to allow containers to"
        echo -e "write to that socket and connect to it. Without it, container sessions may fail to"
        echo -e "reach the API when using socket-based access.\n"
        prompt_yes_no "Install SELinux policy module for API socket access" "y" "INSTALL_SELINUX_POLICY"
    else
        # SELinux typically not used on Ubuntu/Debian
        INSTALL_SELINUX_POLICY=false
    fi
}

# Menu: Summary and Confirmation
menu_summary() {
    print_header
    echo -e "${BOLD}Installation Summary${NC}\n"

    echo -e "  ${BOLD}Detected OS:${NC}       $OS_TYPE (using $PKG_MANAGER)"
    if $CREATE_SERVICE_USER; then
        echo -e "  ${BOLD}Service user:${NC}      $SERVICE_USER ${YELLOW}(will be created)${NC}"
    else
        echo -e "  ${BOLD}Running as:${NC}        $SERVICE_USER"
    fi
    echo -e "  ${BOLD}App install dir:${NC}   $INSTALL_DIR"
    echo -e "  ${BOLD}Config dir:${NC}        $CONFIG_DIR"
    echo -e "  ${BOLD}Data dir:${NC}          $DATA_DIR"
    echo -e "  ${BOLD}Bind address:${NC}      $BIND_ADDRESS"
    echo -e "  ${BOLD}Backend port:${NC}      $BACKEND_PORT"
    echo -e "  ${BOLD}Frontend port:${NC}     $FRONTEND_PORT"
    echo -e "  ${BOLD}Git name:${NC}          $GIT_NAME"
    echo -e "  ${BOLD}Git email:${NC}         $GIT_EMAIL"
    echo ""
    echo -e "  ${BOLD}Forges:${NC}"
    if $FORGE_GITHUB; then
        if $MOUNT_GH_CONFIG; then
            echo -e "    - GitHub ${GREEN}(enabled, config will be mounted)${NC}"
        else
            echo -e "    - GitHub ${GREEN}(enabled)${NC}"
        fi
    else
        echo -e "    - GitHub ${RED}(disabled)${NC}"
    fi
    if $FORGE_GITLAB; then
        if $MOUNT_GLAB_CONFIG; then
            echo -e "    - GitLab ${GREEN}(enabled, config will be mounted)${NC}"
        else
            echo -e "    - GitLab ${GREEN}(enabled)${NC}"
        fi
    else
        echo -e "    - GitLab ${RED}(disabled)${NC}"
    fi
    if $FORGE_GITEA; then
        if $MOUNT_TEA_CONFIG; then
            echo -e "    - Gitea ${GREEN}(enabled, config will be mounted)${NC}"
        else
            echo -e "    - Gitea ${GREEN}(enabled)${NC}"
        fi
    else
        echo -e "    - Gitea ${RED}(disabled)${NC}"
    fi
    echo ""
    if [ -z "$SSH_KEY_PATH" ]; then
        echo -e "  ${BOLD}SSH key:${NC}           ${YELLOW}None (skipped)${NC}"
    elif $GENERATE_SSH_KEY; then
        echo -e "  ${BOLD}SSH key:${NC}           $SSH_KEY_PATH ${YELLOW}(will be generated)${NC}"
        if $CREATE_SERVICE_USER; then
            echo -e "                       ${YELLOW}(will be copied to service user's ~/.ssh/)${NC}"
        fi
    else
        echo -e "  ${BOLD}SSH key:${NC}           $SSH_KEY_PATH"
        if $CREATE_SERVICE_USER; then
            echo -e "                       ${YELLOW}(will be copied to service user's ~/.ssh/)${NC}"
        fi
    fi
    if [ -n "$SSH_CONFIG_PATH" ]; then
        echo -e "  ${BOLD}SSH config:${NC}        $SSH_CONFIG_PATH ${GREEN}(will be bind mounted)${NC}"
    else
        echo -e "  ${BOLD}SSH config:${NC}        ${YELLOW}None${NC}"
    fi
    if $USE_EXISTING_GITCONFIG && [ -n "$GITCONFIG_PATH" ]; then
        echo -e "  ${BOLD}Git config:${NC}        $GITCONFIG_PATH ${GREEN}(existing)${NC}"
    else
        echo -e "  ${BOLD}Git config:${NC}        ${CYAN}New (name=$GIT_NAME, email=$GIT_EMAIL)${NC}"
    fi
    case "$BASH_SHELL_MODE" in
        self)
            echo -e "  ${BOLD}Bash template:${NC}     Run as ${CYAN}$SHELL_USER${NC}"
            if $CREATE_SERVICE_USER; then
                echo -e "                       ${YELLOW}(requires sudoers entry)${NC}"
            fi
            ;;
        service)
            echo -e "  ${BOLD}Bash template:${NC}     Run as ${CYAN}$SHELL_USER${NC} (service user)"
            ;;
        none)
            echo -e "  ${BOLD}Bash template:${NC}     ${YELLOW}Disabled (will be removed)${NC}"
            ;;
    esac
    echo -e "  ${BOLD}TermStation login:${NC} $TERMSTATION_LOGIN"
    echo -e "  ${BOLD}Container runtime:${NC} $CONTAINER_RUNTIME"
    if $BUILD_CONTAINER; then
        echo -e "  ${BOLD}Container:${NC}         Will be built"
        echo -e "                       ${YELLOW}Note: Initial container load may take up to a minute${NC}"
    else
        echo -e "  ${BOLD}Container:${NC}         ${YELLOW}Skipped (build manually later)${NC}"
    fi
    echo ""

    echo -e "${YELLOW}The following commands will require sudo:${NC}"
    $CREATE_SERVICE_USER && echo "  - Creating service user '$SERVICE_USER'"
    $CREATE_SERVICE_USER && echo "  - Adding current user to group '$SERVICE_USER'"
    $CREATE_SERVICE_USER && [ "$BASH_SHELL_MODE" = "self" ] && echo "  - Adding sudoers entry for shell access"
    if [ "$PKG_MANAGER" = "apt" ]; then
        echo "  - apt update and package installation"
    else
        echo "  - dnf makecache and package installation"
    fi
    echo "  - Installing code forge CLIs to /usr/local/bin"
    if [ "$INSTALL_HOST_AI_CLIS" = "true" ]; then
        echo "  - Installing host AI CLI tools (Codex, Claude, Cursor)"
    fi
    if [ "$INSTALL_PTY_TO_HTML" = "true" ]; then
        echo "  - Installing Zig 0.15.2 to /opt/zig (for pty-to-html)"
        echo "    ${YELLOW}WARNING: This will overwrite any existing Zig installation at /opt/zig${NC}"
    fi
    if [ "$INSTALL_SELINUX_POLICY" = "true" ]; then
        echo "  - SELinux policy installation"
    fi
    echo ""

    prompt_yes_no "Proceed with installation" "y" "PROCEED"

    if [ "$PROCEED" != "true" ]; then
        echo -e "\n${RED}Installation cancelled.${NC}"
        exit 0
    fi
}

# Installation Steps
create_service_user() {
    if $CREATE_SERVICE_USER; then
        log_step "Creating service user '$SERVICE_USER'"

        if id "$SERVICE_USER" &>/dev/null; then
            log_warn "User '$SERVICE_USER' already exists"
            # Ensure shell is bash for installation (may have been set to nologin previously)
            log_cmd "sudo usermod -s /bin/bash $SERVICE_USER"
            if ! sudo usermod -s /bin/bash "$SERVICE_USER" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to set shell for '$SERVICE_USER'"
            fi
        else
            # Create with bash shell initially; will switch to nologin at the end
            log_cmd "sudo useradd -m -s /bin/bash $SERVICE_USER"
            if ! sudo useradd -m -s /bin/bash "$SERVICE_USER" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to create user '$SERVICE_USER'"
            fi
            log_info "Created user '$SERVICE_USER'"
        fi

        # Verify the home directory exists
        if [ ! -d "$SERVICE_USER_HOME" ]; then
            die "Service user home directory does not exist: $SERVICE_USER_HOME"
        fi

        # Enable lingering so systemd user services run without active login session
        local uid
        uid=$(id -u "$SERVICE_USER")
        log_cmd "sudo loginctl enable-linger $uid"
        if ! sudo loginctl enable-linger "$uid" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to enable linger for user '$SERVICE_USER'"
        fi
        log_info "Enabled linger for user '$SERVICE_USER' (uid $uid)"

        # Ensure /usr/local/bin is in PATH for the service user
        local profile_path="$SERVICE_USER_HOME/.bashrc"
        local path_snippet='
# Ensure /usr/local/bin is in PATH
if ! [[ "$PATH" =~ "/usr/local/bin" ]]; then
    PATH="$PATH:/usr/local/bin"
fi'
        if ! sudo grep -q '/usr/local/bin' "$profile_path" 2>/dev/null; then
            log_cmd "echo (path_snippet) | sudo tee -a $profile_path"
            echo "$path_snippet" | sudo tee -a "$profile_path" > /dev/null
            log_cmd "sudo chown $SERVICE_USER:$SERVICE_USER $profile_path"
            sudo chown "$SERVICE_USER:$SERVICE_USER" "$profile_path"
            log_info "Added /usr/local/bin to PATH in $profile_path"
        fi

        log_info "Service user home: $SERVICE_USER_HOME"

        # Add the invoking user to the service user's group so they can access
        # files and resources owned by that group (e.g., logs, data directories).
        local invoking_user
        invoking_user=$(logname 2>/dev/null || whoami)
        if [ -n "$invoking_user" ] && [ "$invoking_user" != "$SERVICE_USER" ]; then
            if id "$invoking_user" &>/dev/null && getent group "$SERVICE_USER" &>/dev/null; then
                log_cmd "sudo usermod -aG $SERVICE_USER $invoking_user"
                if sudo usermod -aG "$SERVICE_USER" "$invoking_user" 2>&1 | tee -a "$INSTALL_LOG"; then
                    log_info "Added user '$invoking_user' to group '$SERVICE_USER'"
                else
                    log_warn "Failed to add user '$invoking_user' to group '$SERVICE_USER'"
                fi
            else
                log_warn "Could not add invoking user to group '$SERVICE_USER' (user or group missing)"
            fi
        fi
    fi
}

install_system_packages() {
    log_step "Installing system packages"

    if [ "$PKG_MANAGER" = "apt" ]; then
        install_system_packages_apt
    else
        install_system_packages_dnf
    fi
}

install_system_packages_apt() {
    # Refresh package lists
    log_cmd "sudo apt update"
    echo -e "${YELLOW}Running: sudo apt update${NC}"
    if ! sudo apt update 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to update package lists"
    fi

    # Base packages
    local base_packages="git zip g++ curl ca-certificates gnupg tree gcc g++ make"
    log_cmd "sudo apt install -y $base_packages"
    echo -e "${YELLOW}Running: sudo apt install -y $base_packages${NC}"
    if ! sudo apt install -y $base_packages 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to install required packages"
    fi

    # Install Node.js via NodeSource (Ubuntu repos often have older versions)
    if ! command -v node &> /dev/null; then
        log_info "Installing Node.js 22 via NodeSource..."
        log_cmd "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
        if ! curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to add NodeSource repository"
        fi
        log_cmd "sudo apt install -y nodejs"
        if ! sudo apt install -y nodejs 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to install Node.js"
        fi
    fi
    log_info "Node.js version: $(node --version)"

    # Verify Node.js version is 22+
    local node_major
    node_major=$(node --version | sed 's/v\([0-9]*\).*/\1/')
    if [ "$node_major" -lt 22 ]; then
        echo ""
        echo -e "${RED}${BOLD}ERROR: TermStation requires Node.js 22 or later.${NC}"
        echo -e "${RED}Current version: $(node --version)${NC}"
        echo ""
        echo -e "${YELLOW}To upgrade Node.js on Ubuntu/Debian, run:${NC}"
        echo ""
        echo -e "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
        echo -e "  sudo apt-get install -y nodejs"
        echo ""
        exit 1
    fi

    # Install Docker (only option for Ubuntu)
    log_info "Installing Docker..."

    # Add Docker's official GPG key
    log_cmd "sudo install -m 0755 -d /etc/apt/keyrings"
    sudo install -m 0755 -d /etc/apt/keyrings 2>&1 | tee -a "$INSTALL_LOG"

    log_cmd "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg"
    if ! curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to add Docker GPG key"
    fi
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    # Add Docker repository
    log_cmd "Adding Docker apt repository"
    echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
        sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    log_cmd "sudo apt update"
    if ! sudo apt update 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to update after adding Docker repo"
    fi

    log_cmd "sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    echo -e "${YELLOW}Running: sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin${NC}"
    if ! sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to install Docker packages"
    fi

    log_cmd "sudo systemctl enable --now docker"
    echo -e "${YELLOW}Running: sudo systemctl enable --now docker${NC}"
    if ! sudo systemctl enable --now docker 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to enable Docker service"
    fi

    # Add service user to docker group if using service user
    if $CREATE_SERVICE_USER; then
        log_info "Adding $SERVICE_USER to docker group..."
        log_cmd "sudo usermod -aG docker $SERVICE_USER"
        if ! sudo usermod -aG docker "$SERVICE_USER" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to add $SERVICE_USER to docker group"
        fi
    fi

    # Also add the invoking user to the docker group
    local invoking_user
    invoking_user=$(logname 2>/dev/null || whoami)
    if [ -n "$invoking_user" ]; then
        log_info "Adding $invoking_user to docker group..."
        log_cmd "sudo usermod -aG docker $invoking_user"
        if ! sudo usermod -aG docker "$invoking_user" 2>&1 | tee -a "$INSTALL_LOG"; then
            log_warn "Failed to add $invoking_user to docker group"
        fi
    fi
}

install_system_packages_dnf() {
    # Refresh package metadata
    log_cmd "sudo dnf makecache"
    echo -e "${YELLOW}Running: sudo dnf makecache${NC}"
    if ! sudo dnf makecache 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to refresh package cache"
    fi

    # Base packages (without container runtime)
    log_cmd "sudo dnf install -y git zip gcc-c++ nodejs selinux-policy-devel dnf-plugins-core tree"
    echo -e "${YELLOW}Running: sudo dnf install -y git zip gcc-c++ nodejs selinux-policy-devel dnf-plugins-core tree${NC}"
    if ! sudo dnf install -y git zip gcc-c++ nodejs selinux-policy-devel dnf-plugins-core tree 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to install required packages"
    fi
    log_info "Node.js version: $(node --version)"

    # Verify Node.js version is 22+
    local node_major
    node_major=$(node --version | sed 's/v\([0-9]*\).*/\1/')
    if [ "$node_major" -lt 22 ]; then
        echo ""
        echo -e "${RED}${BOLD}ERROR: TermStation requires Node.js 22 or later.${NC}"
        echo -e "${RED}Current version: $(node --version)${NC}"
        echo ""
        echo -e "${YELLOW}To upgrade Node.js on RHEL/Rocky/CentOS, run:${NC}"
        echo ""
        echo -e "  sudo dnf module reset nodejs"
        echo -e "  sudo dnf module enable nodejs:22"
        echo -e "  sudo dnf install -y nodejs"
        echo ""
        exit 1
    fi

    # Install container runtime
    if [ "$CONTAINER_RUNTIME" = "docker" ]; then
        log_info "Installing Docker..."
        # Enable the official Docker CE repository for RHEL/Rocky/CentOS families.
        log_cmd "sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo"
        echo -e "${YELLOW}Running: sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo${NC}"
        if ! sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to add Docker CE repository (docker runtime selected)"
        fi

        log_cmd "sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
        echo -e "${YELLOW}Running: sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin${NC}"
        if ! sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to install Docker packages"
        fi
        log_cmd "sudo systemctl enable --now docker"
        echo -e "${YELLOW}Running: sudo systemctl enable --now docker${NC}"
        if ! sudo systemctl enable --now docker 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to enable Docker service"
        fi
        # Add service user to docker group if using service user
        if $CREATE_SERVICE_USER; then
            log_info "Adding $SERVICE_USER to docker group..."
            log_cmd "sudo usermod -aG docker $SERVICE_USER"
            if ! sudo usermod -aG docker "$SERVICE_USER" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to add $SERVICE_USER to docker group"
            fi
        fi

        # Also add the invoking user to the docker group so they can use
        # Docker without sudo after refreshing group membership.
        local invoking_user
        invoking_user=$(logname 2>/dev/null || whoami)
        if [ -n "$invoking_user" ]; then
            log_info "Adding $invoking_user to docker group..."
            log_cmd "sudo usermod -aG docker $invoking_user"
            if ! sudo usermod -aG docker "$invoking_user" 2>&1 | tee -a "$INSTALL_LOG"; then
                log_warn "Failed to add $invoking_user to docker group"
            fi
        fi
    else
        log_info "Installing Podman..."
        log_cmd "sudo dnf install -y podman"
        echo -e "${YELLOW}Running: sudo dnf install -y podman${NC}"
        if ! sudo dnf install -y podman 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to install Podman"
        fi
    fi
}

install_bun() {
    log_step "Installing Bun"

    # Install Bun for the invoking user (not the service user) so that
    # optional build steps like chat-to-html can access it via $HOME/.bun/bin.

    if command -v bun &>/dev/null; then
        log_info "Bun is already installed"
        return 0
    fi

    log_cmd "curl -fsSL https://bun.sh/install | bash"
    if ! curl -fsSL https://bun.sh/install | bash 2>&1 | tee -a "$INSTALL_LOG"; then
        log_warn "Failed to install Bun; bun-based optional builds may be skipped"
        return 0
    fi

    log_info "Bun installed"
}

install_ai_tools() {
    log_step "Installing AI CLI tools"

    if [ "$INSTALL_HOST_AI_CLIS" != "true" ]; then
        log_info "Host AI CLI tools installation skipped (per user choice). They will still be available inside the container image."
        return 0
    fi

    # Codex
    log_info "Installing Codex..."
    log_cmd "sudo npm install -g @openai/codex@latest"
    if ! sudo npm install -g @openai/codex@latest 2>&1 | tee -a "$INSTALL_LOG"; then
        log_warn "Failed to install Codex"
    fi

    # Claude Code
    log_info "Installing Claude Code..."
    log_cmd "sudo npm install -g @anthropic-ai/claude-code@latest"
    if ! sudo npm install -g @anthropic-ai/claude-code@latest 2>&1 | tee -a "$INSTALL_LOG"; then
        log_warn "Failed to install Claude Code"
    fi

    # Cursor
    log_info "Installing Cursor..."
    log_cmd "curl -fsSL https://cursor.com/install | bash"
    if ! curl -fsSL https://cursor.com/install 2>&1 | tee -a "$INSTALL_LOG" | bash 2>&1 | tee -a "$INSTALL_LOG"; then
        log_warn "Failed to install Cursor"
    fi
}

install_forge_clis() {
    log_step "Installing code forge CLIs"

    if $FORGE_GITHUB; then
        log_info "Installing GitHub CLI (gh)..."
        if ! command -v gh &> /dev/null; then
            if [ "$PKG_MANAGER" = "apt" ]; then
                # GitHub CLI installation for Debian/Ubuntu
                log_cmd "Installing gh via apt repository"
                (type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) 2>&1 | tee -a "$INSTALL_LOG"
                sudo mkdir -p -m 755 /etc/apt/keyrings
                local out
                out=$(mktemp)
                if ! wget -nv -O"$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg 2>&1 | tee -a "$INSTALL_LOG"; then
                    rm -f "$out"
                    die "Failed to download GitHub CLI keyring"
                fi
                cat "$out" | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
                sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
                rm -f "$out"
                echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
                log_cmd "sudo apt update && sudo apt install gh -y"
                if ! sudo apt update 2>&1 | tee -a "$INSTALL_LOG"; then
                    die "Failed to update after adding GitHub CLI repo"
                fi
                if ! sudo apt install gh -y 2>&1 | tee -a "$INSTALL_LOG"; then
                    die "Failed to install GitHub CLI"
                fi
            else
                log_cmd "sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo"
                if ! sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo 2>&1 | tee -a "$INSTALL_LOG"; then
                    die "Failed to add GitHub CLI repo"
                fi
                log_cmd "sudo dnf install gh -y"
                if ! sudo dnf install gh -y 2>&1 | tee -a "$INSTALL_LOG"; then
                    die "Failed to install GitHub CLI"
                fi
            fi
        fi
        log_info "gh installed: $(gh --version | head -1)"
    fi

    if $FORGE_GITLAB; then
        log_info "Installing GitLab CLI (glab)..."
        if ! command -v glab &> /dev/null; then
            log_cmd "curl -fLO https://gitlab.com/gitlab-org/cli/-/releases/v1.78.3/downloads/glab_1.78.3_linux_amd64.tar.gz"
            if ! curl -fLO https://gitlab.com/gitlab-org/cli/-/releases/v1.78.3/downloads/glab_1.78.3_linux_amd64.tar.gz 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to download GitLab CLI"
            fi
            log_cmd "sudo tar xzf glab_*.tar.gz --strip-components=1 -C /usr/local/bin bin/glab"
            if ! sudo tar xzf glab_*.tar.gz --strip-components=1 -C /usr/local/bin bin/glab 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to extract GitLab CLI"
            fi
            rm -f glab_*.tar.gz
        fi
        log_info "glab installed: $(glab --version)"
    fi

    if $FORGE_GITEA; then
        log_info "Installing Gitea CLI (tea)..."
        if ! command -v tea &> /dev/null; then
            log_cmd "sudo curl -fL https://dl.gitea.com/tea/0.11.1/tea-0.11.1-linux-amd64 -o /usr/local/bin/tea"
            if ! sudo curl -fL https://dl.gitea.com/tea/0.11.1/tea-0.11.1-linux-amd64 -o /usr/local/bin/tea 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to download Gitea CLI"
            fi
            log_cmd "sudo chmod +x /usr/local/bin/tea"
            if ! sudo chmod +x /usr/local/bin/tea 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to set permissions on Gitea CLI"
            fi
        fi
        log_info "tea installed: $(tea --version)"
    fi
}

setup_ssh_key() {
    # Skip if no SSH key selected
    if [ -z "$SSH_KEY_PATH" ]; then
        log_step "Skipping SSH key configuration"
        return 0
    fi

    if $GENERATE_SSH_KEY; then
        log_step "Generating SSH keypair"

        # Check if key already exists
        if [ -f "$SSH_KEY_PATH" ]; then
            log_warn "SSH key already exists at $SSH_KEY_PATH"
        fi

        # Generate key in current user's .ssh directory
        log_cmd "mkdir -p $HOME/.ssh && chmod 700 $HOME/.ssh"
        mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
        log_cmd "ssh-keygen -t ed25519 -C termstation -f $SSH_KEY_PATH"
        ssh-keygen -t ed25519 -C termstation -f "$SSH_KEY_PATH" 2>&1 | tee -a "$INSTALL_LOG"

        echo -e "\n${BOLD}Public key (add this to your code forge):${NC}"
        cat "${SSH_KEY_PATH}.pub"
        echo ""
        press_enter
    else
        log_step "Using existing SSH key"
        log_info "SSH key path: $SSH_KEY_PATH"
    fi

    # Copy SSH key to service user's .ssh directory if using service user
    if $CREATE_SERVICE_USER; then
        log_info "Copying SSH key to service user's ~/.ssh directory..."
        local service_ssh_dir="$SERVICE_USER_HOME/.ssh"

        # Create .ssh directory for service user
        log_cmd "sudo mkdir -p $service_ssh_dir"
        if ! sudo mkdir -p "$service_ssh_dir" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to create $service_ssh_dir"
        fi
        log_cmd "sudo chmod 700 $service_ssh_dir"
        if ! sudo chmod 700 "$service_ssh_dir" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set permissions on $service_ssh_dir"
        fi
        log_cmd "sudo chown $SERVICE_USER:$SERVICE_USER $service_ssh_dir"
        if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$service_ssh_dir" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set ownership on $service_ssh_dir"
        fi

        # Copy private key
        log_cmd "sudo cp $SSH_KEY_PATH $service_ssh_dir/$SSH_KEY_NAME"
        if ! sudo cp "$SSH_KEY_PATH" "$service_ssh_dir/$SSH_KEY_NAME" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to copy SSH private key"
        fi
        log_cmd "sudo chmod 600 $service_ssh_dir/$SSH_KEY_NAME"
        if ! sudo chmod 600 "$service_ssh_dir/$SSH_KEY_NAME" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set permissions on SSH private key"
        fi
        log_cmd "sudo chown $SERVICE_USER:$SERVICE_USER $service_ssh_dir/$SSH_KEY_NAME"
        if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$service_ssh_dir/$SSH_KEY_NAME" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set ownership on SSH private key"
        fi

        # Copy public key
        log_cmd "sudo cp ${SSH_KEY_PATH}.pub $service_ssh_dir/${SSH_KEY_NAME}.pub"
        if ! sudo cp "${SSH_KEY_PATH}.pub" "$service_ssh_dir/${SSH_KEY_NAME}.pub" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to copy SSH public key"
        fi
        log_cmd "sudo chmod 644 $service_ssh_dir/${SSH_KEY_NAME}.pub"
        if ! sudo chmod 644 "$service_ssh_dir/${SSH_KEY_NAME}.pub" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set permissions on SSH public key"
        fi
        log_cmd "sudo chown $SERVICE_USER:$SERVICE_USER $service_ssh_dir/${SSH_KEY_NAME}.pub"
        if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$service_ssh_dir/${SSH_KEY_NAME}.pub" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set ownership on SSH public key"
        fi

        log_info "SSH key copied to $service_ssh_dir/$SSH_KEY_NAME"

        # Update SSH_KEY_PATH to point to service user's copy for config
        SSH_KEY_PATH="$service_ssh_dir/$SSH_KEY_NAME"

        # Copy SSH config if selected
        if [ -n "$SSH_CONFIG_PATH" ]; then
            log_info "Copying SSH config to service user's ~/.ssh directory..."
            log_cmd "sudo cp $SSH_CONFIG_PATH $service_ssh_dir/config"
            if ! sudo cp "$SSH_CONFIG_PATH" "$service_ssh_dir/config" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to copy SSH config"
            fi
            log_cmd "sudo chmod 600 $service_ssh_dir/config"
            if ! sudo chmod 600 "$service_ssh_dir/config" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to set permissions on SSH config"
            fi
            log_cmd "sudo chown $SERVICE_USER:$SERVICE_USER $service_ssh_dir/config"
            if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$service_ssh_dir/config" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to set ownership on SSH config"
            fi
            log_info "SSH config copied to $service_ssh_dir/config"
        fi
    fi
}

copy_forge_configs() {
    log_step "Setting up forge CLI configurations"

    # Only need to copy if using a service user; otherwise configs are already in place
    if ! $CREATE_SERVICE_USER; then
        log_info "Running as current user, forge configs already accessible"
        return 0
    fi

    local service_config_dir="$SERVICE_USER_HOME/.config"

    # Ensure .config directory exists for service user
    log_cmd "sudo mkdir -p $service_config_dir"
    if ! sudo mkdir -p "$service_config_dir" 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to create $service_config_dir"
    fi
    log_cmd "sudo chown $SERVICE_USER:$SERVICE_USER $service_config_dir"
    if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$service_config_dir" 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to set ownership on $service_config_dir"
    fi

    # Copy GitHub CLI config (if source exists)
    if $MOUNT_GH_CONFIG; then
        local gh_src="$HOME/.config/gh"
        local gh_dest="$service_config_dir/gh"
        if [ -d "$gh_src" ]; then
            log_info "Copying GitHub CLI config to service user..."
            log_cmd "sudo cp -r $gh_src $gh_dest"
            if ! sudo cp -r "$gh_src" "$gh_dest" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to copy GitHub CLI config"
            fi
            log_cmd "sudo chown -R $SERVICE_USER:$SERVICE_USER $gh_dest"
            if ! sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$gh_dest" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to set ownership on GitHub CLI config"
            fi
            log_info "GitHub CLI config copied to $gh_dest"
        else
            log_info "GitHub CLI config not found at $gh_src (authenticate after install with: gh auth login)"
        fi
    fi

    # Copy GitLab CLI config (if source exists)
    if $MOUNT_GLAB_CONFIG; then
        local glab_src="$HOME/.config/glab-cli"
        local glab_dest="$service_config_dir/glab-cli"
        if [ -d "$glab_src" ]; then
            log_info "Copying GitLab CLI config to service user..."
            log_cmd "sudo cp -r $glab_src $glab_dest"
            if ! sudo cp -r "$glab_src" "$glab_dest" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to copy GitLab CLI config"
            fi
            log_cmd "sudo chown -R $SERVICE_USER:$SERVICE_USER $glab_dest"
            if ! sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$glab_dest" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to set ownership on GitLab CLI config"
            fi
            log_info "GitLab CLI config copied to $glab_dest"
        else
            log_info "GitLab CLI config not found at $glab_src (authenticate after install with: glab auth login)"
        fi
    fi

    # Copy Gitea CLI config (if source exists)
    if $MOUNT_TEA_CONFIG; then
        local tea_src="$HOME/.config/tea"
        local tea_dest="$service_config_dir/tea"
        if [ -d "$tea_src" ]; then
            log_info "Copying Gitea CLI config to service user..."
            log_cmd "sudo cp -r $tea_src $tea_dest"
            if ! sudo cp -r "$tea_src" "$tea_dest" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to copy Gitea CLI config"
            fi
            log_cmd "sudo chown -R $SERVICE_USER:$SERVICE_USER $tea_dest"
            if ! sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$tea_dest" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to set ownership on Gitea CLI config"
            fi
            log_info "Gitea CLI config copied to $tea_dest"
        else
            log_info "Gitea CLI config not found at $tea_src (authenticate after install with: tea login add)"
        fi
    fi
}

configure_user_shell_access() {
    # Only need sudoers when running as service user and shell runs as different user
    if $CREATE_SERVICE_USER && [ "$BASH_SHELL_MODE" = "self" ]; then
        log_step "Configuring user shell access"

        local sudoers_file="/etc/sudoers.d/termstation-shells"
        local sudoers_entry="$SERVICE_USER ALL=($SHELL_USER) NOPASSWD: /bin/bash"

        log_info "Adding sudoers entry: $sudoers_entry"

        log_cmd "echo '$sudoers_entry' | sudo tee $sudoers_file"
        if ! echo "$sudoers_entry" | sudo tee "$sudoers_file" > /dev/null 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to write sudoers file"
        fi
        log_cmd "sudo chmod 440 $sudoers_file"
        if ! sudo chmod 440 "$sudoers_file" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set permissions on sudoers file"
        fi

        # Validate sudoers file
        log_cmd "sudo visudo -c -f $sudoers_file"
        if sudo visudo -c -f "$sudoers_file" 2>&1 | tee -a "$INSTALL_LOG"; then
            log_info "Sudoers entry configured successfully"
        else
            log_error "Invalid sudoers entry, removing..."
            sudo rm -f "$sudoers_file"
            die "Invalid sudoers configuration"
        fi
    fi
}

create_directories() {
    log_step "Creating TermStation directories"

    # App directory in /opt (requires sudo)
    log_cmd "sudo mkdir -p $INSTALL_DIR"
    if ! sudo mkdir -p "$INSTALL_DIR" 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to create app directory"
    fi

    # User directories for config and data
    if $CREATE_SERVICE_USER; then
        log_cmd "sudo mkdir -p $CONFIG_DIR $DATA_DIR/files"
        if ! sudo mkdir -p "$CONFIG_DIR" "$DATA_DIR/files" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to create user directories"
        fi
        log_cmd "sudo chown -R $SERVICE_USER:$SERVICE_USER $CONFIG_DIR $DATA_DIR"
        if ! sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR" "$DATA_DIR" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set directory ownership"
        fi
        # Also ensure parent XDG dirs exist and are owned correctly
        log_cmd "sudo chown $SERVICE_USER:$SERVICE_USER $(dirname $CONFIG_DIR) $(dirname $DATA_DIR)"
        sudo chown "$SERVICE_USER:$SERVICE_USER" "$(dirname "$CONFIG_DIR")" "$(dirname "$DATA_DIR")" 2>/dev/null || true
    else
        log_cmd "mkdir -p $CONFIG_DIR $DATA_DIR/files"
        if ! mkdir -p "$CONFIG_DIR" "$DATA_DIR/files" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to create user directories"
        fi
    fi

    log_info "Created $INSTALL_DIR"
    log_info "Created $CONFIG_DIR"
    log_info "Created $DATA_DIR/files"
}

create_config_files() {
    log_step "Creating configuration files"

    local ssh_config_file="$DATA_DIR/files/ssh-config"
    local git_config_file="$DATA_DIR/files/gitconfig"

    # SSH config
    log_info "Creating SSH config..."

    local ssh_config_content="# TermStation SSH config
# Forces use of the termstation key for all code forges

Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/termstation
    IdentitiesOnly yes"

    if $FORGE_GITLAB; then
        ssh_config_content="$ssh_config_content

Host gitlab
    HostName gitlab
    User git
    IdentityFile ~/.ssh/termstation
    IdentitiesOnly yes"
    fi

    if $FORGE_GITEA; then
        ssh_config_content="$ssh_config_content

Host gitea
    HostName gitea
    User git
    IdentityFile ~/.ssh/termstation
    IdentitiesOnly yes"
    fi

    # Git config - use existing or create new
    if $USE_EXISTING_GITCONFIG && [ -n "$GITCONFIG_PATH" ]; then
        log_info "Using existing gitconfig from $GITCONFIG_PATH"
        # Copy existing gitconfig
        if $CREATE_SERVICE_USER; then
            if ! sudo cp "$GITCONFIG_PATH" "$git_config_file"; then
                die "Failed to copy gitconfig"
            fi
            # Also copy to service user's home directory
            if ! sudo cp "$GITCONFIG_PATH" "$SERVICE_USER_HOME/.gitconfig"; then
                die "Failed to copy gitconfig to service user home"
            fi
            if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$SERVICE_USER_HOME/.gitconfig"; then
                die "Failed to set gitconfig ownership"
            fi
            log_info "Copied gitconfig to $SERVICE_USER_HOME/.gitconfig"
        else
            if ! cp "$GITCONFIG_PATH" "$git_config_file"; then
                die "Failed to copy gitconfig"
            fi
        fi
    else
        log_info "Creating new gitconfig..."
        local git_config_content="[user]
    name = $GIT_NAME
    email = $GIT_EMAIL"
        if $CREATE_SERVICE_USER; then
            if ! echo "$git_config_content" | sudo tee "$git_config_file" > /dev/null; then
                die "Failed to create git config file"
            fi
        else
            if ! echo "$git_config_content" > "$git_config_file"; then
                die "Failed to create git config file"
            fi
        fi
    fi

    # Write SSH config file with proper ownership
    if $CREATE_SERVICE_USER; then
        if ! echo "$ssh_config_content" | sudo tee "$ssh_config_file" > /dev/null; then
            die "Failed to create SSH config file"
        fi
        if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$ssh_config_file" "$git_config_file"; then
            die "Failed to set config file ownership"
        fi
    else
        if ! echo "$ssh_config_content" > "$ssh_config_file"; then
            die "Failed to create SSH config file"
        fi
    fi

    log_info "Configuration files created"
}

install_selinux_policy() {
    log_step "Installing SELinux policies"

    if [ "$INSTALL_SELINUX_POLICY" != "true" ]; then
        log_warn "SELinux policy installation skipped (per user choice)"
        return 0
    fi

    if ! command -v getenforce &> /dev/null || [ "$(getenforce)" = "Disabled" ]; then
        log_warn "SELinux is not enabled, skipping policy installation"
        return 0
    fi

    local tmp_dir
    tmp_dir=$(mktemp -d) || die "Failed to create temp directory for SELinux policy"

    # Save current directory and change to temp
    local orig_dir="$PWD"
    cd "$tmp_dir" || die "Failed to change to temp directory"

    # List of SELinux policy modules to install
    local policy_dir="$SCRIPT_DIR/backend/scripts/install-templates/selinux"
    local policies=("termstation_socket" "termstation_container_file")

    for policy_name in "${policies[@]}"; do
        local policy_template="$policy_dir/${policy_name}.te"

        if [ ! -f "$policy_template" ]; then
            cd "$orig_dir"
            rm -rf "$tmp_dir"
            die "SELinux policy template not found: $policy_template"
        fi

        cp "$policy_template" "${policy_name}.te" || {
            cd "$orig_dir"
            rm -rf "$tmp_dir"
            die "Failed to copy SELinux policy template: $policy_name"
        }

        log_info "Compiling SELinux policy: $policy_name"

        if ! checkmodule -M -m -o "${policy_name}.mod" "${policy_name}.te"; then
            cd "$orig_dir"
            rm -rf "$tmp_dir"
            die "Failed to compile SELinux policy module: $policy_name"
        fi

        if ! semodule_package -o "${policy_name}.pp" -m "${policy_name}.mod"; then
            cd "$orig_dir"
            rm -rf "$tmp_dir"
            die "Failed to package SELinux policy: $policy_name"
        fi

        if ! sudo semodule -i "${policy_name}.pp"; then
            cd "$orig_dir"
            rm -rf "$tmp_dir"
            die "Failed to install SELinux policy: $policy_name"
        fi

        log_info "Installed SELinux policy: $policy_name"
    done

    cd "$orig_dir" || true
    rm -rf "$tmp_dir"

    log_info "All SELinux policies installed"
}

install_termstation() {
    log_step "Installing TermStation"

    # Verify we're in the repo (backend, frontend, and shared must exist)
    if [ ! -d "$SCRIPT_DIR/backend" ] || [ ! -d "$SCRIPT_DIR/frontend" ] || [ ! -d "$SCRIPT_DIR/shared" ]; then
        die "This script must be run from the termstation repository root. Missing backend/, frontend/, or shared/ directory in: $SCRIPT_DIR"
    fi

    log_info "Installing from repo: $SCRIPT_DIR"

    # Copy frontend, backend, and shared to install directory
    log_info "Copying to install directory: $INSTALL_DIR"

    # App goes to /opt, owned by root, world-readable
    log_cmd "sudo mkdir -p $INSTALL_DIR"
    if ! sudo mkdir -p "$INSTALL_DIR" 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to create install directory"
    fi
    log_cmd "sudo cp -r $SCRIPT_DIR/frontend $SCRIPT_DIR/backend $SCRIPT_DIR/shared $INSTALL_DIR/"
    if ! sudo cp -r "$SCRIPT_DIR/frontend" "$SCRIPT_DIR/backend" "$SCRIPT_DIR/shared" "$INSTALL_DIR/" 2>&1 | tee -a "$INSTALL_LOG"; then
        die "Failed to copy TermStation files"
    fi
    # Make world-readable so any user can run it
    log_cmd "sudo chmod -R a+rX $INSTALL_DIR"
    sudo chmod -R a+rX "$INSTALL_DIR" 2>&1 | tee -a "$INSTALL_LOG"

    # Install npm dependencies (as current user since /opt is now writable via sudo)
    log_info "Installing frontend dependencies..."
    log_cmd "cd $INSTALL_DIR/frontend && sudo npm install"
    (cd "$INSTALL_DIR/frontend" && sudo npm install 2>&1 | tee -a "$INSTALL_LOG") || die "Failed to install frontend dependencies"

    log_info "Installing backend dependencies..."
    log_cmd "cd $INSTALL_DIR/backend && sudo npm install"
    (cd "$INSTALL_DIR/backend" && sudo npm install 2>&1 | tee -a "$INSTALL_LOG") || die "Failed to install backend dependencies"

    log_info "Building backend tools..."
    # Ensure bun is in PATH for the build (may be in user's home dir)
    local bun_path="$HOME/.bun/bin"
    log_cmd "cd $INSTALL_DIR/backend && sudo PATH=\"$bun_path:\$PATH\" npm run build"
    (cd "$INSTALL_DIR/backend" && sudo PATH="$bun_path:$PATH" npm run build 2>&1 | tee -a "$INSTALL_LOG") || die "Failed to build backend tools"

    # Fix permissions after npm install
    log_cmd "sudo chmod -R a+rX $INSTALL_DIR"
    sudo chmod -R a+rX "$INSTALL_DIR" 2>&1 | tee -a "$INSTALL_LOG"

    log_info "TermStation installed successfully"
}

copy_config_from_repo() {
    log_step "Copying configuration from repository"

    # Config source in repo root
    local config_src="$SCRIPT_DIR/backend/config"
    local config_dest="$CONFIG_DIR"
    local data_dest="$DATA_DIR"

    if [ ! -d "$config_src" ]; then
        log_warn "No config directory found in $config_src"
        return 0
    fi

    # Check for json files
    local json_count
    json_count=$(find "$config_src" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l)

    if [ "$json_count" -eq 0 ]; then
        log_warn "No JSON config files found in $config_src"
        return 0
    fi

    # Ensure destination directories exist
    if [ ! -d "$config_dest" ]; then
        if $CREATE_SERVICE_USER; then
            if ! sudo mkdir -p "$config_dest"; then
                die "Failed to create config directory: $config_dest"
            fi
            if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$config_dest"; then
                die "Failed to set config directory ownership"
            fi
        else
            if ! mkdir -p "$config_dest"; then
                die "Failed to create config directory: $config_dest"
            fi
        fi
    fi

    if [ ! -d "$data_dest" ]; then
        if $CREATE_SERVICE_USER; then
            if ! sudo mkdir -p "$data_dest"; then
                die "Failed to create data directory: $data_dest"
            fi
            if ! sudo chown "$SERVICE_USER:$SERVICE_USER" "$data_dest"; then
                die "Failed to set data directory ownership"
            fi
        else
            if ! mkdir -p "$data_dest"; then
                die "Failed to create data directory: $data_dest"
            fi
        fi
    fi

    # Copy config files to appropriate destinations
    # users.json and groups.json go to DATA_DIR, everything else to CONFIG_DIR
    if $CREATE_SERVICE_USER; then
        # Copy users.json and groups.json to data dir
        for f in users.json groups.json; do
            if [ -f "$config_src/$f" ]; then
                if ! sudo cp "$config_src/$f" "$data_dest/"; then
                    die "Failed to copy $f to data directory"
                fi
            fi
        done
        # Copy remaining config files to config dir
        for f in "$config_src"/*.json; do
            local fname
            fname=$(basename "$f")
            if [ "$fname" != "users.json" ] && [ "$fname" != "groups.json" ]; then
                if ! sudo cp "$f" "$config_dest/"; then
                    die "Failed to copy $fname to config directory"
                fi
            fi
        done
        # Copy files/ subdirectory if it exists
        if [ -d "$config_src/files" ]; then
            if ! sudo cp -r "$config_src/files" "$config_dest/"; then
                die "Failed to copy files directory to config directory"
            fi
        fi
        # Set ownership
        if ! sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$config_dest"; then
            die "Failed to set config file ownership"
        fi
        if ! sudo chown -R "$SERVICE_USER:$SERVICE_USER" "$data_dest"; then
            die "Failed to set data file ownership"
        fi
    else
        # Copy users.json and groups.json to data dir
        for f in users.json groups.json; do
            if [ -f "$config_src/$f" ]; then
                if ! cp "$config_src/$f" "$data_dest/"; then
                    die "Failed to copy $f to data directory"
                fi
            fi
        done
        # Copy remaining config files to config dir
        for f in "$config_src"/*.json; do
            local fname
            fname=$(basename "$f")
            if [ "$fname" != "users.json" ] && [ "$fname" != "groups.json" ]; then
                if ! cp "$f" "$config_dest/"; then
                    die "Failed to copy $fname to config directory"
                fi
            fi
        done
        # Copy files/ subdirectory if it exists
        if [ -d "$config_src/files" ]; then
            if ! cp -r "$config_src/files" "$config_dest/"; then
                die "Failed to copy files directory to config directory"
            fi
        fi
    fi

    log_info "Configuration files copied (users.json and groups.json to $data_dest)"
}

configure_installation() {
    log_step "Configuring installation"

    local configure_script="$INSTALL_DIR/backend/scripts/configure-install.mjs"

    if [ ! -f "$configure_script" ]; then
        log_warn "Configure script not found: $configure_script"
        return 0
    fi

    # Determine if SSH config should be used
    local use_ssh_config="false"
    if [ -n "$SSH_CONFIG_PATH" ]; then
        use_ssh_config="true"
    fi

    local args=(
        --config-dir "$CONFIG_DIR"
        --data-dir "$DATA_DIR"
        --bind-address "$BIND_ADDRESS"
        --backend-port "$BACKEND_PORT"
        --frontend-port "$FRONTEND_PORT"
        --service-user "$SERVICE_USER"
        --shell-user "$SHELL_USER"
        --termstation-login "$TERMSTATION_LOGIN"
        --ssh-key-path "$SSH_KEY_PATH"
        --ssh-key-name "$SSH_KEY_NAME"
        --use-ssh-config "$use_ssh_config"
        --bash-shell-mode "$BASH_SHELL_MODE"
        --container-runtime "$CONTAINER_RUNTIME"
        --scripts-dir "$INSTALL_DIR/backend/scripts"
        --enable-github "$FORGE_GITHUB"
        --enable-gitlab "$FORGE_GITLAB"
        --enable-gitea "$FORGE_GITEA"
        --mount-gh-config "$MOUNT_GH_CONFIG"
        --mount-glab-config "$MOUNT_GLAB_CONFIG"
        --mount-tea-config "$MOUNT_TEA_CONFIG"
    )

    if $CREATE_SERVICE_USER; then
        # Run as service user so file ownership is correct
        if ! sudo -u "$SERVICE_USER" node "$configure_script" "${args[@]}"; then
            die "Failed to configure installation"
        fi
    else
        if ! node "$configure_script" "${args[@]}"; then
            die "Failed to configure installation"
        fi
    fi
}

create_start_scripts() {
    log_step "Creating start scripts"

    local templates_dir="$SCRIPT_DIR/backend/scripts/install-templates"
    local backend_template_path="$templates_dir/backend-start.sh.template"
    local frontend_template_path="$templates_dir/frontend-start.sh.template"

    if [ ! -f "$backend_template_path" ] || [ ! -f "$frontend_template_path" ]; then
        die "Start script templates not found in $templates_dir"
    fi

    local backend_start="$INSTALL_DIR/backend/start.sh"
    local frontend_start="$INSTALL_DIR/frontend/start.sh"

    # Load templates
    local backend_template frontend_template
    backend_template=$(<"$backend_template_path")
    frontend_template=$(<"$frontend_template_path")

    # Render backend start script
    local backend_content
    backend_content="${backend_template//@@CONFIG_DIR@@/$CONFIG_DIR}"
    backend_content="${backend_content//@@BIND_ADDRESS@@/$BIND_ADDRESS}"
    backend_content="${backend_content//@@BACKEND_PORT@@/$BACKEND_PORT}"
    backend_content="${backend_content//@@CONTAINER_RUNTIME@@/$CONTAINER_RUNTIME}"

    # Render frontend start script
    local frontend_content
    frontend_content="${frontend_template//@@BIND_ADDRESS@@/$BIND_ADDRESS}"
    frontend_content="${frontend_content//@@FRONTEND_PORT@@/$FRONTEND_PORT}"

    # Always use sudo since INSTALL_DIR is in /opt (owned by root)
    echo "$backend_content" | sudo tee "$backend_start" > /dev/null || die "Failed to create backend start script"
    sudo chmod +x "$backend_start" || die "Failed to set backend start script permissions"

    echo "$frontend_content" | sudo tee "$frontend_start" > /dev/null || die "Failed to create frontend start script"
    sudo chmod +x "$frontend_start" || die "Failed to set frontend start script permissions"

    if $CREATE_SERVICE_USER; then
        sudo chown "$SERVICE_USER:$SERVICE_USER" "$backend_start" "$frontend_start"
    fi

    log_info "Created $backend_start"
    log_info "Created $frontend_start"
}

generate_dockerfile() {
    log_step "Generating Dockerfile"

    local templates_dir="$SCRIPT_DIR/backend/scripts/install-templates"
    local dockerfile_template_path="$templates_dir/Dockerfile.template"
    local entrypoint_template_path="$templates_dir/entrypoint.sh.template"

    if [ ! -f "$dockerfile_template_path" ] || [ ! -f "$entrypoint_template_path" ]; then
        die "Dockerfile or entrypoint template not found in $templates_dir"
    fi

    local dockerfile_path="$CONFIG_DIR/Dockerfile"
    local entrypoint_path="$CONFIG_DIR/entrypoint.sh"

    # Generate gh (GitHub) CLI installation block (using direct binary download to avoid apt GPG issues)
    local gh_block=""
    if [ "$FORGE_GITHUB" = "true" ]; then
        gh_block='# gh (GitHub CLI)
RUN GH_VERSION=$(curl -s https://api.github.com/repos/cli/cli/releases/latest | grep -oP '\''"tag_name": "v\K[^"]+'\'' || echo "2.62.0") && \
    curl -LO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" && \
    tar xzf gh_*.tar.gz --strip-components=1 -C /usr/local && \
    rm gh_*.tar.gz
'
    fi

    # Generate glab (GitLab) CLI installation block
    local glab_block=""
    if [ "$FORGE_GITLAB" = "true" ]; then
        glab_block='# glab (GitLab CLI)
RUN curl -LO https://gitlab.com/gitlab-org/cli/-/releases/v1.78.3/downloads/glab_1.78.3_linux_amd64.tar.gz && \
    tar xzf glab_*.tar.gz \
      --strip-components=1 \
      -C /usr/local/bin \
      bin/glab && \
    rm glab_*.tar.gz
'
    fi

    # Generate tea (Gitea) CLI installation block
    local tea_block=""
    if [ "$FORGE_GITEA" = "true" ]; then
        tea_block='# tea (Gitea CLI)
RUN curl -L https://dl.gitea.com/tea/0.11.1/tea-0.11.1-linux-amd64 -o /usr/local/bin/tea && \
    chmod +x /usr/local/bin/tea
'
    fi

    # Combine forge blocks
    local forge_block=""
    forge_block="${gh_block}${glab_block}${tea_block}"

    # Render Dockerfile content by expanding the forge placeholder sentinel
    local dockerfile_content
    dockerfile_content=$(awk -v forge="$forge_block" '
        $0 == "# @@FORGE_BLOCKS@@" { printf "%s", forge; next }
        { print }
    ' "$dockerfile_template_path")

    # Load entrypoint template
    local entrypoint_template
    entrypoint_template=$(<"$entrypoint_template_path")

    # Write Dockerfile
    if $CREATE_SERVICE_USER; then
        printf '%s\n' "$dockerfile_content" | sudo -u "$SERVICE_USER" tee "$dockerfile_path" > /dev/null || die "Failed to create Dockerfile"
    else
        printf '%s\n' "$dockerfile_content" | tee "$dockerfile_path" > /dev/null || die "Failed to create Dockerfile"
    fi

    # Write entrypoint.sh
    if $CREATE_SERVICE_USER; then
        printf '%s\n' "$entrypoint_template" | sudo -u "$SERVICE_USER" tee "$entrypoint_path" > /dev/null || die "Failed to create entrypoint script"
    else
        printf '%s\n' "$entrypoint_template" | tee "$entrypoint_path" > /dev/null || die "Failed to create entrypoint script"
    fi

    log_info "Created $dockerfile_path"
    log_info "Created $entrypoint_path"
}

build_container_image() {
    log_step "Building container image"

    local dockerfile_path="$CONFIG_DIR/Dockerfile"

    # Check file exists (need sudo test for service user's files)
    if $CREATE_SERVICE_USER; then
        if ! sudo test -f "$dockerfile_path"; then
            die "Dockerfile not found: $dockerfile_path"
        fi
    else
        if [ ! -f "$dockerfile_path" ]; then
            die "Dockerfile not found: $dockerfile_path"
        fi
    fi

    echo -e "${YELLOW}Running: $CONTAINER_RUNTIME build -f $dockerfile_path -t termstation $CONFIG_DIR${NC}"
    if $CREATE_SERVICE_USER; then
        # Run from config dir to avoid permission issues with current working directory
        log_cmd "sudo -u $SERVICE_USER bash -c 'cd $CONFIG_DIR && $CONTAINER_RUNTIME build --no-cache -f Dockerfile -t termstation .'"
        if ! sudo -u "$SERVICE_USER" bash -c "cd '$CONFIG_DIR' && $CONTAINER_RUNTIME build --no-cache -f Dockerfile -t termstation ." 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to build container image"
        fi
    else
        if [ "$CONTAINER_RUNTIME" = "docker" ]; then
            # Use newgrp so the current shell picks up the updated docker
            # group membership added during installation.
            log_cmd "newgrp docker << 'EOF'
cd \"$CONFIG_DIR\"
docker build --no-cache -f Dockerfile -t termstation .
EOF"
            if ! newgrp docker <<EOF
cd "$CONFIG_DIR"
docker build --no-cache -f Dockerfile -t termstation .
EOF
            then
                die "Failed to build container image"
            fi
        else
            log_cmd "$CONTAINER_RUNTIME build --no-cache -f $dockerfile_path -t termstation $CONFIG_DIR"
            if ! $CONTAINER_RUNTIME build --no-cache -f "$dockerfile_path" -t termstation "$CONFIG_DIR" 2>&1 | tee -a "$INSTALL_LOG"; then
                die "Failed to build container image"
            fi
        fi
    fi

    log_info "Container image 'termstation' built successfully"
}

build_optional_dependencies() {
    log_step "Building optional dependencies"

    # Build as the current user (who has sudo), then copy to /opt/termstation/backend/scripts
    local build_dir
    build_dir=$(mktemp -d) || die "Failed to create temp build directory"
    local scripts_dir="$INSTALL_DIR/backend/scripts"

    if [ "$INSTALL_CHAT_TO_HTML" = "true" ]; then
        echo -e "\n${BOLD}Optional: chat-to-html${NC} (for Chat Log tab)"
        log_info "Installing chat-to-html..."

        # Clone and build as current user
        log_cmd "git clone https://github.com/kcosr/chat-to-html $build_dir/chat-to-html"
        if ! git clone https://github.com/kcosr/chat-to-html "$build_dir/chat-to-html" 2>&1 | tee -a "$INSTALL_LOG"; then
            rm -rf "$build_dir"
            die "Failed to clone chat-to-html"
        fi

        cd "$build_dir/chat-to-html" || die "Failed to cd to chat-to-html"
        log_cmd "npm install (chat-to-html)"
        if ! npm install 2>&1 | tee -a "$INSTALL_LOG"; then
            cd - > /dev/null
            rm -rf "$build_dir"
            die "Failed to npm install for chat-to-html"
        fi
        log_cmd "npm run build (chat-to-html)"
        if ! npm run build 2>&1 | tee -a "$INSTALL_LOG"; then
            cd - > /dev/null
            rm -rf "$build_dir"
            die "Failed to build chat-to-html"
        fi

        # Source bun if available for bun build
        export PATH="$HOME/.bun/bin:$PATH"
        # Temporarily disable nounset for sourcing shell profiles (they may reference undefined vars)
        set +u
        source ~/.bash_profile 2>/dev/null || source ~/.bashrc 2>/dev/null || true
        set -u

        if command -v bun &> /dev/null; then
            log_info "Building with bun..."
            log_cmd "npm run build:bun (chat-to-html)"
            if ! npm run build:bun 2>&1 | tee -a "$INSTALL_LOG"; then
                cd - > /dev/null
                rm -rf "$build_dir"
                die "Failed to build chat-to-html with bun"
            fi
        else
            log_warn "Bun not found in PATH, skipping bun build"
        fi

        # Copy to /opt/termstation/backend/scripts (owned by root)
        local chat_js="$build_dir/chat-to-html/dist/chat-to-html.js"
        if [ -f "$chat_js" ]; then
            log_cmd "sudo cp $chat_js $scripts_dir/"
            if ! sudo cp "$chat_js" "$scripts_dir/" 2>&1 | tee -a "$INSTALL_LOG"; then
                log_warn "Failed to copy chat-to-html.js from $chat_js; chat-to-html will be unavailable"
            else
                log_cmd "sudo chmod a+rx $scripts_dir/chat-to-html.js"
                sudo chmod a+rx "$scripts_dir/chat-to-html.js" 2>&1 | tee -a "$INSTALL_LOG"
                log_info "chat-to-html installed to $scripts_dir/"
            fi
        else
            log_warn "chat-to-html build did not produce $chat_js; skipping chat-to-html helper"
        fi

        cd - > /dev/null
    fi

    if [ "$INSTALL_PTY_TO_HTML" = "true" ]; then
        echo -e "\n${BOLD}Optional: pty-to-html${NC} (for HTML terminal history)"
        log_info "Installing pty-to-html..."

        # Clone and build as current user
        log_cmd "git clone https://github.com/kcosr/pty-to-html $build_dir/pty-to-html"
        if ! git clone https://github.com/kcosr/pty-to-html "$build_dir/pty-to-html" 2>&1 | tee -a "$INSTALL_LOG"; then
            rm -rf "$build_dir"
            die "Failed to clone pty-to-html"
        fi

        cd "$build_dir/pty-to-html" || die "Failed to cd to pty-to-html"
        log_cmd "./setup.sh (pty-to-html)"
        if ! ./setup.sh 2>&1 | tee -a "$INSTALL_LOG"; then
            cd - > /dev/null
            rm -rf "$build_dir"
            die "Failed to build pty-to-html"
        fi

        # Copy to /opt/termstation/backend/scripts (owned by root)
        log_cmd "sudo cp $build_dir/pty-to-html/zig-out/bin/pty-to-html $scripts_dir/"
        if ! sudo cp "$build_dir/pty-to-html/zig-out/bin/pty-to-html" "$scripts_dir/" 2>&1 | tee -a "$INSTALL_LOG"; then
            cd - > /dev/null
            rm -rf "$build_dir"
            die "Failed to copy pty-to-html"
        fi
        log_cmd "sudo chmod a+rx $scripts_dir/pty-to-html"
        sudo chmod a+rx "$scripts_dir/pty-to-html" 2>&1 | tee -a "$INSTALL_LOG"

        cd - > /dev/null
        log_info "pty-to-html installed to $scripts_dir/"
    fi

    # Cleanup build directory
    rm -rf "$build_dir"
}

lock_service_user() {
    if $CREATE_SERVICE_USER; then
        log_step "Locking service user shell"

        log_cmd "sudo usermod -s /sbin/nologin $SERVICE_USER"
        if ! sudo usermod -s /sbin/nologin "$SERVICE_USER" 2>&1 | tee -a "$INSTALL_LOG"; then
            die "Failed to set shell to nologin for '$SERVICE_USER'"
        fi
        log_info "Set shell to /sbin/nologin for '$SERVICE_USER'"
    fi

    # Log completion
    if [[ -n "$INSTALL_LOG" ]]; then
        echo "" >> "$INSTALL_LOG"
        echo "=== Installation Complete ===" >> "$INSTALL_LOG"
        echo "Finished: $(date)" >> "$INSTALL_LOG"
    fi
}

print_completion() {
    print_header
    echo -e "${GREEN}${BOLD}Installation Complete!${NC}\n"

    echo -e "${BOLD}Installation Summary:${NC}\n"
    if $CREATE_SERVICE_USER; then
        echo -e "  ${BOLD}Service user:${NC}      $SERVICE_USER"
    else
        echo -e "  ${BOLD}Running as:${NC}        $SERVICE_USER"
    fi
    echo -e "  ${BOLD}App install dir:${NC}   $INSTALL_DIR"
    echo -e "  ${BOLD}Config dir:${NC}        $CONFIG_DIR"
    echo -e "  ${BOLD}Data dir:${NC}          $DATA_DIR"
    if [ -n "$SSH_KEY_PATH" ]; then
        echo -e "  ${BOLD}SSH key:${NC}           $SSH_KEY_PATH"
    else
        echo -e "  ${BOLD}SSH key:${NC}           ${YELLOW}None${NC}"
    fi
    echo -e "  ${BOLD}Bind address:${NC}      $BIND_ADDRESS"
    echo -e "  ${BOLD}Backend port:${NC}      $BACKEND_PORT"
    echo -e "  ${BOLD}Frontend port:${NC}     $FRONTEND_PORT"
    echo -e "  ${BOLD}Container runtime:${NC} $CONTAINER_RUNTIME"
    echo -e "  ${BOLD}Install log:${NC}       $INSTALL_LOG"
    echo ""
    echo -e "  ${BOLD}Forges:${NC}"
    $FORGE_GITHUB && echo -e "    - GitHub ${GREEN}(enabled)${NC}" || echo -e "    - GitHub ${RED}(disabled)${NC}"
    $FORGE_GITLAB && echo -e "    - GitLab ${GREEN}(enabled)${NC}" || echo -e "    - GitLab ${RED}(disabled)${NC}"
    $FORGE_GITEA && echo -e "    - Gitea ${GREEN}(enabled)${NC}" || echo -e "    - Gitea ${RED}(disabled)${NC}"
    echo ""

    echo -e "${BOLD}Next Steps:${NC}\n"

    local step=1

    if [ -n "$SSH_KEY_PATH" ] && $GENERATE_SSH_KEY; then
        echo -e "$step. Add your SSH public key to your code forge(s):"
        if $CREATE_SERVICE_USER; then
            echo -e "   ${CYAN}sudo cat ${SSH_KEY_PATH}.pub${NC}\n"
        else
            echo -e "   ${CYAN}cat ${SSH_KEY_PATH}.pub${NC}\n"
        fi
        ((step++))
    fi

    echo -e "$step. Start the backend:"
    if $CREATE_SERVICE_USER; then
        echo -e "   ${CYAN}sudo -u $SERVICE_USER $INSTALL_DIR/backend/start.sh${NC}\n"
    else
        echo -e "   ${CYAN}$INSTALL_DIR/backend/start.sh${NC}\n"
    fi
    ((step++))

    echo -e "$step. Start the frontend (in another terminal):"
    if $CREATE_SERVICE_USER; then
        echo -e "   ${CYAN}sudo -u $SERVICE_USER $INSTALL_DIR/frontend/start.sh${NC}\n"
    else
        echo -e "   ${CYAN}$INSTALL_DIR/frontend/start.sh${NC}\n"
    fi
    ((step++))

    echo -e "$step. Access TermStation at:"
    local access_host
    if [ "$BIND_ADDRESS" = "127.0.0.1" ]; then
        access_host="localhost"
    else
        access_host="$(hostname -f 2>/dev/null || hostname || echo "$BIND_ADDRESS")"
    fi
    echo -e "   ${CYAN}http://$access_host:$FRONTEND_PORT${NC}\n"

    echo -e "   Default login: ${BOLD}$TERMSTATION_LOGIN${NC} / ${BOLD}fixme${NC}"
    echo -e "   ${YELLOW}Note:${NC} You will be prompted to change your password after first login."
    echo -e "   If accessing over HTTP (not HTTPS), passwords are transmitted in plain text."
    echo -e "   Passwords are hashed and not stored in plain text, but HTTP transmission is not encrypted."
    echo -e "   For production or remote access, consider using HTTPS (see INSTALL.md).\n"
    ((step++))

    echo -e "$step. (Optional) Authenticate AI CLIs (Claude, Codex, Cursor) for user ${CYAN}$SERVICE_USER${NC}:"
    echo -e "   Run their login/setup commands as ${CYAN}$SERVICE_USER${NC}."
    if $CREATE_SERVICE_USER; then
        echo -e "   For example: ${CYAN}sudo -u $SERVICE_USER -i bash${NC}"
    fi
    echo -e "   On machines without browser access, you can authenticate on another machine,"
    echo -e "   then copy the files listed below into this user's home directory.\n"

    local claude_credentials codex_auth cursor_auth claude_profile codex_config cursor_config
    claude_credentials="$SERVICE_USER_HOME/.claude/.credentials.json"
    claude_profile="$SERVICE_USER_HOME/.claude.json"
    codex_auth="$SERVICE_USER_HOME/.codex/auth.json"
    codex_config="$SERVICE_USER_HOME/.codex/config.toml"
    cursor_auth="$SERVICE_USER_HOME/.config/cursor/auth.json"
    cursor_config="$SERVICE_USER_HOME/.cursor/cli-config.json"

    echo -e "   ${BOLD}Claude CLI files (used by the Claude template):${NC}"
    echo -e "     ${CYAN}$claude_credentials${NC}"
    echo -e "     ${CYAN}$claude_profile${NC}\n"

    echo -e "   ${BOLD}Codex CLI files (used by the Codex templates):${NC}"
    echo -e "     ${CYAN}$codex_auth${NC}"
    echo -e "     ${CYAN}$codex_config${NC}\n"

    echo -e "   ${BOLD}Cursor CLI files (used by the Cursor template):${NC}"
    echo -e "     ${CYAN}$cursor_auth${NC}"
    echo -e "     ${CYAN}$cursor_config${NC}\n"

    # Forge CLI authentication notes - show for any enabled forge with mount configured
    local has_forge_mounts=false
    if $MOUNT_GH_CONFIG || $MOUNT_GLAB_CONFIG || $MOUNT_TEA_CONFIG; then
        has_forge_mounts=true
    fi

    if $has_forge_mounts; then
        ((step++))
        echo -e "$step. Authenticate code forge CLIs (if not already done):"
        if $CREATE_SERVICE_USER; then
            echo -e "   Run these commands as ${CYAN}$SERVICE_USER${NC}:"
            echo -e "   ${CYAN}sudo -u $SERVICE_USER -i bash${NC}\n"
        else
            echo -e "   Run these commands to authenticate:\n"
        fi

        if $MOUNT_GH_CONFIG; then
            echo -e "   ${BOLD}GitHub CLI:${NC}"
            echo -e "     ${CYAN}gh auth login${NC}"
            echo -e "     Config: ${CYAN}~/.config/gh/${NC}\n"
        fi

        if $MOUNT_GLAB_CONFIG; then
            echo -e "   ${BOLD}GitLab CLI:${NC}"
            echo -e "     ${CYAN}glab auth login${NC}"
            echo -e "     Config: ${CYAN}~/.config/glab-cli/${NC}\n"
        fi

        if $MOUNT_TEA_CONFIG; then
            echo -e "   ${BOLD}Gitea CLI:${NC}"
            echo -e "     ${CYAN}tea login add${NC}"
            echo -e "     Config: ${CYAN}~/.config/tea/${NC}\n"
        fi
    fi

    echo -e "${BOLD}Container Image:${NC}"
    echo -e "   Dockerfile: ${CYAN}$CONFIG_DIR/Dockerfile${NC}"
    echo -e "   To rebuild after editing:"
    if $CREATE_SERVICE_USER; then
        echo -e "   ${CYAN}sudo -u $SERVICE_USER $CONTAINER_RUNTIME build -f $CONFIG_DIR/Dockerfile -t termstation $CONFIG_DIR${NC}"
    else
        if [ "$CONTAINER_RUNTIME" = "docker" ]; then
            echo -e "   ${CYAN}# Refresh docker group membership then build${NC}"
            echo -e "   ${CYAN}newgrp docker${NC}"
            echo -e "   ${CYAN}docker build -f $CONFIG_DIR/Dockerfile -t termstation $CONFIG_DIR${NC}"
        else
            echo -e "   ${CYAN}$CONTAINER_RUNTIME build -f $CONFIG_DIR/Dockerfile -t termstation $CONFIG_DIR${NC}"
        fi
    fi

    echo ""
    echo -e "${BOLD}Tip:${NC} To avoid a brief wait on first container launch in the UI, you can prime the container now:"
    if $CREATE_SERVICE_USER; then
        echo -e "   ${CYAN}sudo -u $SERVICE_USER $CONTAINER_RUNTIME run --rm termstation echo 'Container primed'${NC}"
    else
        if [ "$CONTAINER_RUNTIME" = "docker" ]; then
            echo -e "   ${CYAN}docker run --rm termstation echo 'Container primed'${NC}"
        else
            echo -e "   ${CYAN}$CONTAINER_RUNTIME run --rm termstation echo 'Container primed'${NC}"
        fi
    fi

    # Firewall note for non-localhost installs
    if [ "$BIND_ADDRESS" != "127.0.0.1" ]; then
        echo ""
        echo -e "${YELLOW}${BOLD}Note:${NC} If you have a firewall enabled, you may need to allow ports ${BOLD}$BACKEND_PORT${NC} and ${BOLD}$FRONTEND_PORT${NC}."
    fi
}

# Main
main() {
    # Detect OS first (sets OS_TYPE, PKG_MANAGER, and default CONTAINER_RUNTIME)
    detect_os
    log_info "Detected OS: $OS_TYPE (package manager: $PKG_MANAGER)"

    # Collect configuration (prompt install dir and upgrade decision first)
    menu_install_location
    menu_service_user
    menu_basic_config
    menu_git_config
    menu_forge_selection
    menu_ssh_key
    menu_forge_auth
    menu_user_shells
    menu_container
    menu_optional_dependencies
    menu_summary

    # Initialize install log (always writable by the invoking user)
    INSTALL_LOG="$(pwd)/termstation-install.log"
    mkdir -p "$(dirname "$INSTALL_LOG")"
    echo "=== TermStation Installation Log ===" > "$INSTALL_LOG"
    echo "Started: $(date)" >> "$INSTALL_LOG"
    echo "User: $(whoami)" >> "$INSTALL_LOG"
    echo "Host: $(hostname)" >> "$INSTALL_LOG"
    echo "" >> "$INSTALL_LOG"
    log_info "Installation log: $INSTALL_LOG"

    # Run installation
    create_service_user
    install_system_packages
    install_bun
    install_ai_tools
    install_forge_clis
    setup_ssh_key
    copy_forge_configs
    configure_user_shell_access
    create_directories
    create_config_files
    install_selinux_policy
    install_termstation
    copy_config_from_repo
    configure_installation
    create_start_scripts
    generate_dockerfile
    if $BUILD_CONTAINER; then
        build_container_image
    fi
    build_optional_dependencies
    lock_service_user

    # Done
    print_completion
}

main "$@"
