import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { supabase } from "../services/supabase.js";
import {
  createEventFolder,
  uploadEventPhoto,
  getDrivePhotoStream,
} from "../drive.js";
import { requireAdmin } from "../middlewares/requireAdmin.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 11 },
  fileFilter: (_req, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      cb(new Error("Envie uma imagem JPEG, PNG ou WebP."));
      return;
    }
    cb(null, true);
  },
});

const eventSchema = z.object({
  name: z.string().trim().min(2).max(150),
  eventDate: z.iso.date(),
  maxPhotosPerGuest: z.coerce.number().int().min(1).max(100).default(10),
  maxGuests: z.coerce.number().int().positive().optional(),
});

function publicEventUrl(token: string) {
  const base = process.env.PUBLIC_APP_URL ?? "http://localhost:5173";
  return `${base.replace(/\/$/, "")}/e/${token}`;
}

function failDatabase(error: unknown) {
  console.error(error);
}

router.post("/", requireAdmin, upload.single("cover"), async (req, res) => {
  const parsed = eventSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      message: "Dados do evento inválidos.",
      errors: parsed.error.flatten(),
    });
    return;
  }

  if (!req.file) {
    res.status(400).json({ message: "A capa do evento é obrigatória." });
    return;
  }

  try {
    const userId = req.adminId!;

    const folderId = await createEventFolder(userId, parsed.data.name);

    const cover = await uploadEventPhoto(userId, folderId, {
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
    });

    const { data, error } = await supabase
      .from("events")
      .insert({
        admin_id: req.adminId!,
        name: parsed.data.name,
        event_date: parsed.data.eventDate,
        drive_folder_id: folderId,
        cover_file_id: cover.id,
        max_photos_per_guest: parsed.data.maxPhotosPerGuest,
        max_guests: parsed.data.maxGuests ?? null,
      })
      .select("id,name,event_date,public_token,created_at")
      .single();

    if (error) throw error;

    res.status(201).json({
      event: data,
      publicUrl: publicEventUrl(data.public_token),
    });
  } catch (error) {
    failDatabase(error);
    res.status(500).json({
      message: "Não foi possível criar o evento.",
    });
  }
});

async function getEventStats(eventId: string) {
  const [visitors, photos, featured] = await Promise.all([
    supabase
      .from("visitors")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId),

    supabase
      .from("photos")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId),

    supabase
      .from("photos")
      .select("id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("is_featured", true),
  ]);

  if (visitors.error || photos.error || featured.error) {
    throw new Error("Erro ao calcular estatísticas do evento.");
  }

  return {
    uniqueVisitors: visitors.count ?? 0,
    totalPhotos: photos.count ?? 0,
    featuredPhotos: featured.count ?? 0,
  };
}


router.get("/", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("events")
    .select(
      "id,name,event_date,cover_file_id,public_token,created_at,max_photos_per_guest,max_guests",
    )
    .eq("admin_id", req.adminId!)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ message: "Erro ao listar eventos." });
    return;
  }

  try {
    const eventsWithStats = await Promise.all(
      (data ?? []).map(async (event) => {
        const stats = await getEventStats(event.id);

        return {
          id: event.id,
          name: event.name,
          event_date: event.event_date,
          public_token: event.public_token,
          created_at: event.created_at,
          maxPhotosPerGuest: event.max_photos_per_guest,
          maxGuests: event.max_guests,
          cover_file_id: event.cover_file_id,
          coverUrl: `/api/events/public/${event.public_token}/cover`,
          publicUrl: publicEventUrl(event.public_token),
          stats,
          photoCount: stats.totalPhotos,
          visitorCount: stats.uniqueVisitors,
        };
      }),
    );

    res.json({ events: eventsWithStats });
  } catch (error) {
    console.error("Erro ao calcular estatísticas:", error);
    res.status(500).json({
      message: "Erro ao carregar estatísticas dos eventos.",
    });
  }
});


router.get("/public/:token", async (req, res) => {
  const { data, error } = await supabase
    .from("events")
    .select("id,name,event_date,cover_file_id,public_token")
    .eq("public_token", req.params.token)
    .maybeSingle();

  if (error || !data) {
    res.status(404).json({ message: "Evento não encontrado." });
    return;
  }

  res.json({
    event: {
      id: data.id,
      name: data.name,
      eventDate: data.event_date,
      coverUrl: `/api/events/public/${data.public_token}/cover`,
    },
  });
});

router.post("/public/:token/visits", async (req, res) => {
  const visitorSchema = z.object({
    visitorToken: z.string().uuid(),
  });

  const parsed = visitorSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ message: "Identificador de visitante inválido." });
    return;
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id,max_guests")
    .eq("public_token", req.params.token)
    .maybeSingle();

  if (eventError || !event) {
    res.status(404).json({ message: "Evento não encontrado." });
    return;
  }

  const { data: existing, error: visitorError } = await supabase
    .from("visitors")
    .select("id")
    .eq("event_id", event.id)
    .eq("visitor_token", parsed.data.visitorToken)
    .maybeSingle();

  if (visitorError) {
    res.status(500).json({ message: "Erro ao consultar visitante." });
    return;
  }

  if (existing) {
    const { error } = await supabase
      .from("visitors")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", existing.id);

    if (error) {
      res.status(500).json({ message: "Erro ao atualizar visita." });
      return;
    }

    res.json({ visitorId: existing.id, returningVisitor: true });
    return;
  }

  if (event.max_guests !== null) {
    const { count, error } = await supabase
      .from("visitors")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id);

    if (error) {
      res.status(500).json({ message: "Erro ao verificar convidados." });
      return;
    }

    if ((count ?? 0) >= event.max_guests) {
      res.status(409).json({ message: "Limite de convidados atingido." });
      return;
    }
  }

  const { data: visitor, error } = await supabase
    .from("visitors")
    .insert({
      event_id: event.id,
      visitor_token: parsed.data.visitorToken,
    })
    .select("id")
    .single();

  if (error) {
    // Também pode ocorrer uma corrida entre duas requisições do mesmo navegador.
    res.status(500).json({ message: "Não foi possível registrar a visita." });
    return;
  }

  res.status(201).json({
    visitorId: visitor.id,
    returningVisitor: false,
  });
});

router.post(
  "/public/:token/photos",
  upload.array("photos", 10),
  async (req, res) => {
    const parsed = z
      .object({
        visitorToken: z.string().uuid(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ message: "Identifique o visitante primeiro." });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    if (!files.length) {
      res.status(400).json({ message: "Selecione pelo menos uma foto." });
      return;
    }

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id,admin_id,drive_folder_id,max_photos_per_guest")
      .eq("public_token", req.params.token)
      .maybeSingle();

    if (eventError || !event) {
      res.status(404).json({ message: "Evento não encontrado." });
      return;
    }

    const { data: visitor, error: visitorError } = await supabase
      .from("visitors")
      .select("id")
      .eq("event_id", event.id)
      .eq("visitor_token", parsed.data.visitorToken)
      .maybeSingle();

    if (visitorError || !visitor) {
      res.status(403).json({
        message: "Registre o acesso ao evento antes de enviar fotos.",
      });
      return;
    }

    const { count, error: countError } = await supabase
      .from("photos")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id)
      .eq("visitor_id", visitor.id);

    if (countError) {
      res.status(500).json({ message: "Erro ao verificar limite de fotos." });
      return;
    }

    if ((count ?? 0) + files.length > event.max_photos_per_guest) {
      res.status(400).json({
        message: `O limite é de ${event.max_photos_per_guest} fotos por visitante.`,
      });
      return;
    }

    const uploadedIds: string[] = [];

    try {
      const saved = [];

      for (const file of files) {
        const driveFile = await uploadEventPhoto(
          event.admin_id,
          event.drive_folder_id,
          {
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype,
          },
        );

        uploadedIds.push(driveFile.id);

        const { data: photo, error } = await supabase
          .from("photos")
          .insert({
            event_id: event.id,
            visitor_id: visitor.id,
            drive_file_id: driveFile.id,
            original_name: file.originalname,
            mime_type: file.mimetype,
            size_bytes: file.size,
          })
          .select("id,original_name,uploaded_at")
          .single();

        if (error) throw error;
        saved.push(photo);
      }

      res.status(201).json({
        message: `${saved.length} foto(s) enviada(s).`,
        photos: saved,
      });
    } catch (error) {
      // Compensa uploads parciais: remove arquivos já enviados ao Drive.
      const { deleteDrivePhoto } = await import("../drive.js");

      await Promise.allSettled(
        uploadedIds.map((id) => deleteDrivePhoto(event.admin_id, id)),
      );

      failDatabase(error);
      res.status(500).json({ message: "Erro ao salvar as fotos." });
    }
  },
);

router.get("/public/:token/featured", async (req, res) => {
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id")
    .eq("public_token", req.params.token)
    .maybeSingle();

  if (eventError || !event) {
    res.status(404).json({ message: "Evento não encontrado." });
    return;
  }

  const { data, error } = await supabase
    .from("photos")
    .select("id,original_name,uploaded_at")
    .eq("event_id", event.id)
    .eq("is_featured", true)
    .order("uploaded_at", { ascending: false });

  if (error) {
    res.status(500).json({ message: "Erro ao listar destaques." });
    return;
  }

  res.json({
    photos: (data ?? []).map((photo) => ({
      ...photo,
      imageUrl: `/api/events/public/${req.params.token}/photos/${photo.id}/image`,
    })),
  });
});

router.patch(
  "/:eventId/photos/:photoId/featured",
  requireAdmin,
  async (req, res) => {
    const parsed = z
      .object({
        featured: z.boolean(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ message: "Informe featured como booleano." });
      return;
    }

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id")
      .eq("id", req.params.eventId)
      .eq("admin_id", req.adminId!)
      .maybeSingle();

    if (eventError) {
      res.status(500).json({ message: "Erro ao buscar o evento." });
      return;
    }
    if (eventError || !event) {
      res.status(404).json({ message: "Evento não encontrado." });
      return;
    }

    const { data, error } = await supabase
      .from("photos")
      .update({ is_featured: parsed.data.featured })
      .eq("id", req.params.photoId)
      .eq("event_id", event.id)
      .select("id,is_featured")
      .maybeSingle();

    if (error || !data) {
      res.status(404).json({ message: "Foto não encontrada." });
      return;
    }

    res.json({ photo: data });
  },
);

router.get("/:eventId/stats", requireAdmin, async (req, res) => {
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id")
    .eq("id", req.params.eventId)
    .eq("admin_id", req.adminId!)
    .maybeSingle();

  if (eventError || !event) {
    res.status(404).json({ message: "Evento não encontrado." });
    return;
  }

  const [visitors, photos, featured] = await Promise.all([
    supabase
      .from("visitors")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id),
    supabase
      .from("photos")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id),
    supabase
      .from("photos")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id)
      .eq("is_featured", true),
  ]);

  if (visitors.error || photos.error || featured.error) {
    res.status(500).json({ message: "Erro ao calcular estatísticas." });
    return;
  }

  res.json({
    uniqueVisitors: visitors.count ?? 0,
    totalPhotos: photos.count ?? 0,
    featuredPhotos: featured.count ?? 0,
  });
});

// Transmite imagens sem tornar o arquivo do Drive público.
router.get("/public/:token/cover", async (req, res) => {
  const { data: event } = await supabase
    .from("events")
    .select("admin_id,cover_file_id")
    .eq("public_token", req.params.token)
    .maybeSingle();

  if (!event?.cover_file_id) {
    res.status(404).json({ message: "Capa não encontrada." });
    return;
  }

  try {
    const stream = await getDrivePhotoStream(
      event.admin_id,
      event.cover_file_id,
    );
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Content-Type", "image/jpeg");
    stream.on("error", () => {
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    stream.pipe(res);
  } catch {
    res.status(502).json({ message: "Não foi possível carregar a capa." });
  }
});

router.get("/public/:token/photos/:photoId/image", async (req, res) => {
  const { data: event } = await supabase
    .from("events")
    .select("id,admin_id")
    .eq("public_token", req.params.token)
    .maybeSingle();

  if (!event) {
    res.status(404).end();
    return;
  }

  const { data: photo } = await supabase
    .from("photos")
    .select("drive_file_id,mime_type")
    .eq("id", req.params.photoId)
    .eq("event_id", event.id)
    .eq("is_featured", true)
    .maybeSingle();

  if (!photo) {
    res.status(404).end();
    return;
  }

  try {
    const stream = await getDrivePhotoStream(
      event.admin_id,
      photo.drive_file_id,
    );
    res.setHeader("Content-Type", photo.mime_type);
    res.setHeader("Cache-Control", "public, max-age=300");
    stream.on("error", () => {
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    stream.pipe(res);
  } catch {
    res.status(502).json({ message: "Não foi possível carregar a imagem." });
  }
});

// GET /api/events/:eventId/photos
router.get("/:eventId/photos", requireAdmin, async (req, res) => {
  const { eventId } = req.params;

  // Confirma que o evento pertence ao administrador
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id")
    .eq("id", eventId)
    .eq("admin_id", req.adminId!)
    .maybeSingle();

  if (eventError) {
    res.status(500).json({ message: "Erro ao verificar o evento." });
    return;
  }

  if (!event) {
    res.status(404).json({ message: "Evento não encontrado." });
    return;
  }

  // Busca as fotos do evento
  const { data: photos, error } = await supabase
  .from("photos")
  .select(
    "id, event_id, original_name, mime_type, size_bytes, is_featured",
  )
  .eq("event_id", eventId);

  if (error) {
  console.error("Erro ao listar fotos no Supabase:", error);

  res.status(500).json({
    message: "Erro ao listar as fotos.",
    details: error.message,
    code: error.code,
  });

  return;
}

  res.json({
    photos: (photos ?? []).map((photo) => ({
      ...photo,
      imageUrl: `/api/events/${eventId}/photos/${photo.id}/image`,
    })),
  });
});

// GET /api/events/:eventId/photos/:photoId/image
router.get(
  "/:eventId/photos/:photoId/image",
  requireAdmin,
  async (req, res) => {
    const { eventId, photoId } = req.params;

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id")
      .eq("id", eventId)
      .eq("admin_id", req.adminId!)
      .maybeSingle();

    if (eventError) {
      res.status(500).json({ message: "Erro ao verificar o evento." });
      return;
    }

    if (!event) {
      res.status(404).json({ message: "Evento não encontrado." });
      return;
    }

    const { data: photo, error: photoError } = await supabase
      .from("photos")
      .select("drive_file_id, mime_type")
      .eq("id", photoId)
      .eq("event_id", eventId)
      .maybeSingle();

    if (photoError) {
      res.status(500).json({ message: "Erro ao buscar a foto." });
      return;
    }

    if (!photo) {
      res.status(404).json({ message: "Foto não encontrada." });
      return;
    }

    try {
      const stream = await getDrivePhotoStream(
        req.adminId!,
        photo.drive_file_id,
      );

      res.setHeader("Content-Type", photo.mime_type);
      res.setHeader("Cache-Control", "private, max-age=300");

      stream.on("error", (error) => {
        console.error("Erro ao transmitir imagem:", error);

        if (!res.headersSent) {
          res.status(502).json({ message: "Erro ao carregar a imagem." });
        } else {
          res.destroy(error);
        }
      });

      stream.pipe(res);
    } catch (error) {
      console.error("Erro ao buscar imagem no Google Drive:", error);
      res.status(502).json({ message: "Não foi possível carregar a imagem." });
    }
  },
);

// GET /api/events/public/:token/featured
router.get("/public/:token/featured", async (req, res) => {
  const { token } = req.params;

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id")
    .eq("public_token", token)
    .maybeSingle();

  if (eventError) {
    console.error("Erro ao buscar evento público:", eventError);
    res.status(500).json({ message: "Erro ao buscar o evento." });
    return;
  }

  if (!event) {
    res.status(404).json({ message: "Evento não encontrado." });
    return;
  }

  const { data: photos, error: photosError } = await supabase
    .from("photos")
    .select("id, original_name, mime_type, size_bytes, is_featured")
    .eq("event_id", event.id)
    .eq("is_featured", true);

  if (photosError) {
    console.error("Erro ao buscar fotos destacadas:", photosError);
    res.status(500).json({ message: "Erro ao buscar fotos destacadas." });
    return;
  }

  res.json({
    photos: (photos ?? []).map((photo) => ({
      ...photo,
      imageUrl: `/api/events/public/${encodeURIComponent(token)}/photos/${photo.id}/image`,
    })),
  });
});


// GET /api/events/public/:token/photos/:photoId/image
router.get(
  "/public/:token/photos/:photoId/image",
  async (req, res) => {
    const { token, photoId } = req.params;

    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("id, admin_id")
      .eq("public_token", token)
      .maybeSingle();

    if (eventError) {
      console.error("Erro ao buscar evento:", eventError);
      res.status(500).json({ message: "Erro ao buscar o evento." });
      return;
    }

    if (!event) {
      res.status(404).json({ message: "Evento não encontrado." });
      return;
    }

    const { data: photo, error: photoError } = await supabase
      .from("photos")
      .select("id, drive_file_id, mime_type, is_featured")
      .eq("id", photoId)
      .eq("event_id", event.id)
      .eq("is_featured", true)
      .maybeSingle();

    if (photoError) {
      console.error("Erro ao buscar foto:", photoError);
      res.status(500).json({ message: "Erro ao buscar a foto." });
      return;
    }

    if (!photo) {
      res.status(404).json({
        message: "Foto não encontrada ou não está destacada.",
      });
      return;
    }

    try {
      const stream = await getDrivePhotoStream(
        event.admin_id,
        photo.drive_file_id,
      );

      res.setHeader("Content-Type", photo.mime_type);
      res.setHeader("Cache-Control", "public, max-age=60");

      stream.on("error", (error) => {
        console.error("Erro ao transmitir foto do Drive:", error);

        if (!res.headersSent) {
          res.status(502).json({ message: "Erro ao carregar a imagem." });
        } else {
          res.destroy(error);
        }
      });

      stream.pipe(res);
    } catch (error) {
      console.error("Erro ao abrir foto no Drive:", error);

      if (!res.headersSent) {
        res.status(502).json({ message: "Erro ao carregar a imagem." });
      }
    }
  },
);

export default router;
