import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { getDrive } from "./google.js";

export async function createEventFolder(userId: string, name: string) {
  const drive = await getDrive(userId);

  const result = await drive.files.create({
    requestBody: {
      name: `Wedding Album - ${name}`,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id,name",
  });

  if (!result.data.id) {
    throw new Error("Não foi possível criar a pasta do evento.");
  }

  return result.data.id;
}

export async function uploadEventPhoto(
  userId: string,
  folderId: string,
  file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
  },
) {
  const drive = await getDrive(userId);

  const result = await drive.files.create({
    requestBody: {
      name: `${randomUUID()}-${file.originalname}`,
      parents: [folderId],
    },
    media: {
      mimeType: file.mimetype,
      body: Readable.from(file.buffer),
    },
    fields: "id,name,mimeType,size,createdTime",
  });

  const fileId = result.data.id;

  if (!fileId) {
    throw new Error("O Google Drive não retornou o ID da foto.");
  }

  return {
    ...result.data,
    id: fileId,
  };
}

export async function deleteDrivePhoto(userId: string, fileId: string) {
  const drive = await getDrive(userId);

  await drive.files.delete({ fileId });
}

export async function getDrivePhotoStream(userId: string, fileId: string) {
  const drive = await getDrive(userId);

  const result = await drive.files.get(
    {
      fileId,
      alt: "media",
    },
    {
      responseType: "stream",
    },
  );

  return result.data as Readable;
}
