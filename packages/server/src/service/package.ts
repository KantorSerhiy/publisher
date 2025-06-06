import * as fs from "fs/promises";
import * as path from "path";
import { components } from "../api";
import recursive from "recursive-readdir";
import { PackageNotFoundError } from "../errors";
import { Model } from "./model";
import {
   PACKAGE_MANIFEST_NAME,
   MODEL_FILE_SUFFIX,
   NOTEBOOK_FILE_SUFFIX,
   getWorkingDirectory,
} from "../utils";
import { Scheduler } from "./scheduler";
import { metrics } from "@opentelemetry/api";
import { Connection } from "@malloydata/malloy";
import { createConnections } from "./connection";
import { DuckDBConnection } from "@malloydata/db-duckdb";

type ApiDatabase = components["schemas"]["Database"];
type ApiModel = components["schemas"]["Model"];
export type ApiPackage = components["schemas"]["Package"];
type ApiSchedule = components["schemas"]["Schedule"];

export class Package {
   private packageName: string;
   private packageMetadata: ApiPackage;
   private databases: ApiDatabase[];
   private models: Map<string, Model> = new Map();
   private scheduler: Scheduler | undefined;
   private static meter = metrics.getMeter("publisher");
   private static packageLoadHistogram = this.meter.createHistogram(
      "malloy_package_load_duration",
      {
         description: "Time taken to load a Malloy package",
         unit: "ms",
      },
   );

   constructor(
      packageName: string,
      packageMetadata: ApiPackage,
      databases: ApiDatabase[],
      models: Map<string, Model>,
      scheduler: Scheduler | undefined,
   ) {
      this.packageName = packageName;
      this.packageMetadata = packageMetadata;
      this.databases = databases;
      this.models = models;
      this.scheduler = scheduler;
   }

   static async create(
      packageName: string,
      projectConnections: Map<string, Connection>,
   ): Promise<Package> {
      const startTime = performance.now();
      // If package manifest does not exist, we throw a not found error.  If the package
      // manifest exists, we create a Package object and record errors in the object's fields.
      await Package.validatePackageManifestExistsOrThrowError(packageName);

      try {
         const packageConfig = await Package.readPackageConfig(packageName);
         const databases = await Package.readDatabases(packageName);
         const connections = new Map<string, Connection>(projectConnections);

         // Package connections override project connections.
         const { malloyConnections: packageConnections } =
            await createConnections(
               path.join(getWorkingDirectory(), packageName),
            );
         packageConnections.forEach((connection) => {
            connections.set(connection.name, connection);
         });

         // Add a duckdb connection for the package.
         connections.set(
            "duckdb",
            new DuckDBConnection(
               "duckdb",
               ":memory:",
               Package.getPackagePath(packageName),
            ),
         );

         const models = await Package.loadModels(packageName, connections);
         const scheduler = Scheduler.create(models);
         const endTime = performance.now();
         const executionTime = endTime - startTime;
         this.packageLoadHistogram.record(executionTime, {
            malloy_package_name: packageName,
            status: "success",
         });
         return new Package(
            packageName,
            packageConfig,
            databases,
            models,
            scheduler,
         );
      } catch (error) {
         console.error(error);
         const endTime = performance.now();
         const executionTime = endTime - startTime;
         this.packageLoadHistogram.record(executionTime, {
            malloy_package_name: packageName,
            status: "error",
         });
         return new Package(
            packageName,
            {
               name: packageName,
               description:
                  "Unable to load package: " + (error as Error).message,
            },
            new Array<ApiDatabase>(),
            new Map<string, Model>(),
            undefined,
         );
      }
   }

   public getPackageName(): string {
      return this.packageName;
   }

   public getPackageMetadata(): ApiPackage {
      return this.packageMetadata;
   }

   public listDatabases(): ApiDatabase[] {
      return this.databases;
   }

   public listSchedules(): ApiSchedule[] {
      return this.scheduler ? this.scheduler.list() : [];
   }

   public getModel(modelPath: string): Model | undefined {
      return this.models.get(modelPath);
   }

   public listModels(): ApiModel[] {
      return Array.from(this.models.keys()).map((modelPath) => {
         return {
            path: modelPath,
            type: modelPath.endsWith(MODEL_FILE_SUFFIX) ? "source" : "notebook",
         } as ApiModel;
      });
   }

   private static async loadModels(
      packageName: string,
      connections: Map<string, Connection>,
   ): Promise<Map<string, Model>> {
      const modelPaths = await Package.getModelPaths(packageName);
      const models = await Promise.all(
         modelPaths.map((modelPath) =>
            Model.create(packageName, modelPath, connections),
         ),
      );
      return new Map(models.map((model) => [model.getPath(), model]));
   }

   private static getPackagePath(packageName: string): string {
      return path.join(getWorkingDirectory(), packageName);
   }

   private static async getModelPaths(packageName: string): Promise<string[]> {
      const packagePath = Package.getPackagePath(packageName);
      let files = undefined;
      try {
         files = await recursive(packagePath);
      } catch (error) {
         console.log(error);
         throw new PackageNotFoundError(
            `Package config for ${packageName} does not exist.`,
         );
      }
      return files
         .map((fullPath: string) => {
            return fullPath.replace(packagePath + "/", "");
         })
         .filter(
            (modelPath: string) =>
               modelPath.endsWith(MODEL_FILE_SUFFIX) ||
               modelPath.endsWith(NOTEBOOK_FILE_SUFFIX),
         );
   }

   private static async validatePackageManifestExistsOrThrowError(
      packageName: string,
   ) {
      const packageConfigPath = path.join(
         Package.getPackagePath(packageName),
         PACKAGE_MANIFEST_NAME,
      );
      try {
         await fs.stat(packageConfigPath);
      } catch {
         throw new PackageNotFoundError(
            `Package manifest for ${packageName} does not exist.`,
         );
      }
   }

   private static async readPackageConfig(
      packageName: string,
   ): Promise<ApiPackage> {
      const packageConfigPath = path.join(
         Package.getPackagePath(packageName),
         PACKAGE_MANIFEST_NAME,
      );
      const packageConfigContents = await fs.readFile(packageConfigPath);
      // TODO: Validate package manifest.  Define manifest type in public API.
      const packageManifest = JSON.parse(packageConfigContents.toString());
      return { name: packageName, description: packageManifest.description };
   }

   private static async readDatabases(
      packageName: string,
   ): Promise<ApiDatabase[]> {
      return await Promise.all(
         (await Package.getDatabasePaths(packageName)).map(
            async (databasePath) => {
               const databaseSize: number = await Package.getDatabaseSize(
                  packageName,
                  databasePath,
               );
               return {
                  path: databasePath,
                  size: databaseSize,
                  type: "embedded",
               } as ApiDatabase;
            },
         ),
      );
   }

   private static async getDatabasePaths(
      packageName: string,
   ): Promise<string[]> {
      const packagePath = Package.getPackagePath(packageName);
      let files = undefined;
      files = await recursive(packagePath);
      return files
         .map((fullPath: string) => {
            return fullPath.replace(packagePath + "/", "");
         })
         .filter((modelPath: string) => modelPath.endsWith(".parquet"));
   }

   private static async getDatabaseSize(
      packageName: string,
      databasePath: string,
   ): Promise<number> {
      const fullPath = path.join(
         Package.getPackagePath(packageName),
         databasePath,
      );
      return (await fs.stat(fullPath)).size;
   }
}
