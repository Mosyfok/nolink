
(() => {
  /* =========================================
     ПРОФИЛЬ СОБЕСЕДНИКА
     ========================================= */

  const profileModal = document.getElementById("profile-modal");
  const profileTitle = profileModal.querySelector(".profile-card h2");
  const chatAvatar = document.getElementById("chat-avatar");

  function openOtherUserProfile() {
    if (!activeChat || activeChat.type === "group") return;

    const user = getOtherMember(activeChat);
    if (!user) return;

    profileTitle.textContent = "Профиль пользователя";

    document.getElementById("profile-avatar").textContent =
      (user.username || "N").charAt(0).toUpperCase();

    const usernameElement = document.getElementById("profile-username");

    if (typeof renderVerifiedName === "function") {
      renderVerifiedName(
        usernameElement,
        user.username || "Пользователь",
        user.isVerified
      );
    } else {
      usernameElement.textContent = user.username || "Пользователь";
    }

    // Почта другого пользователя не раскрывается.
    document.getElementById("profile-email").textContent =
      "Не отображается";

    document.getElementById("profile-nolink-id").textContent =
      user.nolinkId
        ? formatNolinkId(user.nolinkId)
        : "Не указан";

    document.getElementById("profile-presence").textContent =
      user.isOnline ? "В сети" : "Не в сети";

    const created = user.createdAt
      ? new Date(user.createdAt)
      : null;

    document.getElementById("profile-created").textContent =
      created && !Number.isNaN(created.getTime())
        ? created.toLocaleDateString("ru-RU", {
            day: "2-digit",
            month: "long",
            year: "numeric"
          })
        : "—";

    profileModal.classList.remove("hidden");
  }

  chatAvatar.addEventListener("click", openOtherUserProfile);

  chatAvatar.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openOtherUserProfile();
    }
  });

  // При открытии собственного профиля возвращаем его заголовок.
  document.getElementById("profile-open").addEventListener("click", () => {
    profileTitle.textContent = "Мой профиль";
  });

  /* =========================================
     ПОЛНОЭКРАННЫЙ ПРОСМОТР ФОТОГРАФИЙ
     ========================================= */

  const viewer = document.getElementById("photo-viewer");
  const viewerImage = document.getElementById("photo-viewer-image");
  const stage = document.getElementById("photo-viewer-stage");

  const closeButton = document.getElementById("photo-viewer-close");
  const zoomInButton = document.getElementById("photo-zoom-in");
  const zoomOutButton = document.getElementById("photo-zoom-out");
  const zoomResetButton = document.getElementById("photo-zoom-reset");
  const saveButton = document.getElementById("photo-save");

  let zoom = 1;

  function updateZoom() {
    viewerImage.style.transform = `scale(${zoom})`;
    zoomResetButton.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(value) {
    zoom = Math.min(5, Math.max(0.25, value));
    updateZoom();
  }

  function openPhotoViewer(source) {
    if (!source) return;

    viewerImage.src = source;
    viewer.classList.remove("hidden");

    setZoom(1);

    document.body.style.overflow = "hidden";
    closeButton.focus();
  }

  function closePhotoViewer() {
    viewer.classList.add("hidden");
    viewerImage.removeAttribute("src");
    document.body.style.overflow = "";
    setZoom(1);
  }

  // Обработчик на контейнере работает и для фотографий,
  // которые загружаются в сообщения позднее.
  document.getElementById("messages").addEventListener("click", event => {
    const image = event.target.closest(".message-image");

    if (!image || !image.src) return;

    openPhotoViewer(image.src);
  });

  closeButton.addEventListener("click", closePhotoViewer);

  viewer.addEventListener("click", event => {
    if (event.target === viewer) {
      closePhotoViewer();
    }
  });

  zoomInButton.addEventListener("click", () => {
    setZoom(zoom + 0.25);
  });

  zoomOutButton.addEventListener("click", () => {
    setZoom(zoom - 0.25);
  });

  zoomResetButton.addEventListener("click", () => {
    setZoom(1);
  });

  // Увеличение и уменьшение колёсиком мыши.
  stage.addEventListener("wheel", event => {
    if (viewer.classList.contains("hidden")) return;

    event.preventDefault();

    if (event.deltaY < 0) {
      setZoom(zoom + 0.15);
    } else {
      setZoom(zoom - 0.15);
    }
  }, { passive: false });

  // Двойной щелчок переключает обычный и увеличенный масштаб.
  viewerImage.addEventListener("dblclick", () => {
    setZoom(zoom === 1 ? 2 : 1);
  });

  // Сохранение фотографии на компьютер.
  saveButton.addEventListener("click", () => {
    const source = viewerImage.src;

    if (!source) return;

    let extension = "png";

    if (source.startsWith("data:image/jpeg")) {
      extension = "jpg";
    } else if (source.startsWith("data:image/webp")) {
      extension = "webp";
    } else if (source.startsWith("data:image/gif")) {
      extension = "gif";
    }

    const link = document.createElement("a");
    link.href = source;
    link.download = `nolink-photo-${Date.now()}.${extension}`;

    document.body.appendChild(link);
    link.click();
    link.remove();
  });

  // Закрытие просмотрщика клавишей Escape.
  document.addEventListener("keydown", event => {
    if (
      event.key === "Escape" &&
      !viewer.classList.contains("hidden")
    ) {
      closePhotoViewer();
    }
  });
})();
