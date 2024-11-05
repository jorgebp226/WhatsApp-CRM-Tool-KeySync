require('dotenv').config();
const express = require('express');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const OpenAI = require('openai');
const http = require('http');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Configuración de DynamoDB
const dynamoDBClient = new DynamoDBClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});
const ddbDocClient = DynamoDBDocumentClient.from(dynamoDBClient);

// Configuración de OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Almacenar clientes de WhatsApp por sub de Cognito
const whatsappClients = {};

// Función para obtener la IP pública de la instancia EC2
const getPublicIP = async () => {
    return new Promise((resolve, reject) => {
        const options = {
            host: '169.254.169.254',
            path: '/latest/meta-data/public-ipv4',
            timeout: 1000
        };
        http.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data.trim()));
        }).on('error', (err) => {
            console.error('Error al obtener la IP pública:', err);
            reject(err);
        });
    });
};

// Función para almacenar el código QR en DynamoDB con estado y IP pública
const storeQRCode = async (sub, qrDataUrl, prompt) => {
    try {
        const publicIP = await getPublicIP();
        const params = {
            TableName: 'WhatsAppQRCodes',
            Item: {
                sub: sub,
                qrCode: qrDataUrl,
                timestamp: new Date().toISOString(),
                estado: 'pendiente',
                publicIP: publicIP,
                prompt: prompt
            }
        };
        await ddbDocClient.send(new PutCommand(params));
        console.log(`Código QR almacenado en DynamoDB para sub: ${sub}`);
        return true;
    } catch (error) {
        console.error('Error al almacenar el código QR:', error);
        return false;
    }
};

// Función para actualizar el estado del QR en DynamoDB
const updateQRCodeEstado = async (sub, estado) => {
    try {
        const params = {
            TableName: 'WhatsAppQRCodes',
            Key: { sub: sub },
            UpdateExpression: 'set estado = :e',
            ExpressionAttributeValues: {
                ':e': estado
            }
        };
        await ddbDocClient.send(new UpdateCommand(params));
        console.log(`Estado del QR actualizado a '${estado}' para sub: ${sub}`);
    } catch (error) {
        console.error(`Error al actualizar el estado del QR para sub ${sub}:`, error);
    }
};

// Función para obtener el prompt para un sub desde DynamoDB
const getPromptForSub = async (sub) => {
    try {
        const params = {
            TableName: 'WhatsAppQRCodes',
            Key: { sub: sub },
            ProjectionExpression: 'prompt'
        };
        const command = new GetCommand(params);
        const response = await ddbDocClient.send(command);
        if (response.Item && response.Item.prompt) {
            return response.Item.prompt;
        } else {
            throw new Error('Prompt no encontrado para el sub proporcionado.');
        }
    } catch (error) {
        console.error(`Error al obtener el prompt para sub ${sub}:`, error);
        throw error;
    }
};

// Endpoint para iniciar el proceso con límites configurables y prompt
app.post('/start/:sub', async (req, res) => {
    const { sub } = req.params;
    const { maxChats = 20, maxMessagesPerChat = 1000, prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ message: 'El parámetro "prompt" es requerido.', success: false });
    }

    console.log(`Solicitud recibida para iniciar cliente WhatsApp para sub: ${sub}`);
    console.log(`Configuración - Máximo de Chats: ${maxChats}, Máximo de Mensajes Por Chat: ${maxMessagesPerChat}, Prompt: ${prompt}`);

    // Verificar si ya existe un QR escaneado para este sub
    try {
        const params = {
            TableName: 'WhatsAppQRCodes',
            Key: { sub: sub },
            ProjectionExpression: 'estado'
        };
        const command = new GetCommand(params);
        const response = await ddbDocClient.send(command);
        if (response.Item && response.Item.estado === 'escaneado') {
            return res.status(400).json({ message: 'QR ya escaneado para este sub. No se pueden generar nuevos QRs.', success: false });
        }
    } catch (error) {
        console.error(`Error al verificar el estado del QR para sub ${sub}:`, error);
        // Continuar si no existe el sub
    }

    if (whatsappClients[sub]) {
        console.log(`Cliente ya iniciado para sub: ${sub}`);
        return res.status(400).json({ message: 'Cliente ya iniciado para este sub.', success: false });
    }

    // Inicializar cliente de WhatsApp
    const client = new Client({
        puppeteer: { 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    let qrSent = false;

    client.on('qr', async (qr) => {
        console.log(`QR generado para sub: ${sub}`);
        try {
            const qrDataUrl = await qrcode.toDataURL(qr);
            const stored = await storeQRCode(sub, qrDataUrl, prompt);
            
            if (stored && !qrSent) {
                qrSent = true;
                res.json({ 
                    message: 'Código QR generado y almacenado. Puede obtenerlo usando el endpoint /qr/:sub',
                    success: true
                });
            }
        } catch (err) {
            console.error('Error al generar QR:', err);
            if (!qrSent) {
                qrSent = true;
                res.status(500).json({ 
                    error: 'Error al generar el código QR',
                    success: false
                });
            }
        }
    });

    client.on('ready', async () => {
        console.log(`Cliente WhatsApp listo para sub: ${sub}`);
        // Actualizar estado a 'escaneado'
        await updateQRCodeEstado(sub, 'escaneado');
        // Procesar chats
        processChats(sub, maxChats, maxMessagesPerChat).catch(err => {
            console.error(`Error al procesar chats para sub ${sub}:`, err);
        });
    });

    client.on('authenticated', () => {
        console.log(`Autenticado exitosamente para sub: ${sub}`);
    });

    client.on('auth_failure', (msg) => {
        console.error(`Falló la autenticación para sub ${sub}:`, msg);
    });

    client.on('disconnected', (reason) => {
        console.log(`Cliente desconectado para sub ${sub}:`, reason);
        delete whatsappClients[sub];
    });

    console.log(`Inicializando cliente de WhatsApp para sub: ${sub}`);
    client.initialize();
    whatsappClients[sub] = client;
});

// Función para analizar la conversación con OpenAI
async function analyzeConversation(conversation, prompt) {
    console.log('Iniciando análisis de conversación con OpenAI...');
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "Eres un asistente que extrae información relevante de conversaciones de WhatsApp para un CRM."
                },
                {
                    role: "user",
                    content: `
${prompt}
    
Conversación:
${conversation}
    
Asegúrate de que la respuesta sea únicamente el objeto JSON sin texto adicional.
`
                }
            ],
            temperature: 0.7,
            max_tokens: 500,
            n: 1,
            stop: null,
        });

        console.log('Análisis completado. Procesando respuesta de OpenAI...');
        let content = response.choices[0].message.content;

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Respuesta de OpenAI no contiene un JSON válido.');
        }

        const jsonString = jsonMatch[0];
        const parsedData = JSON.parse(jsonString);

        return {
            necesitaSeguimiento: parsedData.necesitaSeguimiento || 'No',
            ultimoMensaje: parsedData.ultimoMensaje || new Date().toISOString(),
            esCliente: parsedData.esCliente || 'No',
            resumenConversacion: parsedData.resumenConversacion || '',
            scoreLead: parsedData.scoreLead || 0,
            estadoLead: parsedData.estadoLead || '',
            productosenviados: parsedData.productosenviados || []
        };

    } catch (error) {
        console.error('Error al analizar la conversación:', error);
        return {
            necesitaSeguimiento: 'No',
            ultimoMensaje: new Date().toISOString(),
            esCliente: 'No',
            resumenConversacion: '',
            scoreLead: 0,
            estadoLead: '',
            productosenviados: []
        };
    }
}

// Función para procesar chats con límites configurables
const processChats = async (sub, maxChats, maxMessagesPerChat) => {
    console.log(`Iniciando proceso de chats para sub: ${sub}`);
    const client = whatsappClients[sub];
    if (!client) {
        console.error(`Cliente no encontrado para sub: ${sub}`);
        return;
    }

    try {
        const chats = await client.getChats();
        console.log(`Encontrados ${chats.length} chats para sub ${sub}. Comenzando exportación...`);

        const limitedChats = chats.slice(0, maxChats);

        for (let i = 0; i < limitedChats.length; i++) {
            const chat = limitedChats[i];
            console.log(`Procesando chat ${i + 1}/${limitedChats.length}: ${chat.name}`);

            let allMessages = [];
            let lastMessageId = null;
            const batchSize = 100;

            while (allMessages.length < maxMessagesPerChat) {
                const messages = await chat.fetchMessages({
                    limit: batchSize,
                    before: lastMessageId
                });
                if (messages.length === 0) break;
                allMessages = allMessages.concat(messages);
                lastMessageId = messages[messages.length - 1].id._serialized;
                console.log(`Mensajes obtenidos para ${chat.name}: ${allMessages.length}`);
            }

            const formattedMessages = allMessages.map(msg => ({
                de: msg.from === client.info.wid._serialized ? 'Tu' : msg.from,
                cuerpo: msg.body,
                timestamp: msg.timestamp
            }));

            const conversation = formattedMessages.map(m => `${m.de}: ${m.cuerpo}`).join('\n');

            // Obtener el prompt para este sub
            let prompt;
            try {
                prompt = await getPromptForSub(sub);
            } catch (err) {
                console.error(`No se pudo obtener el prompt para sub ${sub}. Usando prompt por defecto.`);
                prompt = `
Eres un experto en crear CRMs para prospectos de un agente inmobiliario.
Analiza la siguiente conversación de WhatsApp entre el agente y un contacto y extrae la siguiente información en formato JSON. Si no parece una conversación con un cliente, establece "esCliente" como "No".

La respuesta debe estar en formato JSON válido con las siguientes claves:
1. necesitaSeguimiento (Si/No)
2. ultimoMensaje (fecha y hora en formato ISO)
3. esCliente (Si/No)
4. resumenConversacion
5. scoreLead (número entre 1-100)
6. estadoLead (una de las siguientes opciones: "Primeras conversaciones", "Presupuestos y casas presentadas", "Primeras visitas presenciales hechas", "Casa comprada – seguimiento")
7. productosenviados (lista de strings, pueden ser calles, links, etc.)

Conversación:
${conversation}

Asegúrate de que la respuesta sea únicamente el objeto JSON sin texto adicional.
`;
            }

            const parsedData = await analyzeConversation(conversation, prompt);

            const item = {
                sub: sub,
                chatId: chat.id._serialized,
                nombreContacto: chat.name || '',
                telefono: chat.id.user || '',
                mensajes: formattedMessages,
                necesitaSeguimiento: parsedData.necesitaSeguimiento,
                ultimoMensaje: parsedData.ultimoMensaje,
                esCliente: parsedData.esCliente,
                resumenConversacion: parsedData.resumenConversacion,
                scoreLead: parsedData.scoreLead,
                estadoLead: parsedData.estadoLead,
                productosenviados: parsedData.productosenviados
            };

            try {
                const params = new PutCommand({ TableName: 'WhatsAppCRM', Item: item });
                await ddbDocClient.send(params);
                console.log(`Datos almacenados en DynamoDB para el chat ${chat.name}.`);
            } catch (dynamoError) {
                console.error(`Error al almacenar datos en DynamoDB para el chat ${chat.name}:`, dynamoError);
            }
        }

        console.log(`Exportación completada para sub ${sub}.`);

    } catch (error) {
        console.error(`Error al procesar chats para sub ${sub}:`, error);
    }
};

// Nuevo Endpoint para enviar mensajes a través de WhatsApp
app.post('/send-message/:sub', async (req, res) => {
    const { sub } = req.params;
    const { recipient, message } = req.body;

    if (!recipient || !message) {
        return res.status(400).json({ message: 'Parámetros "recipient" y "message" son requeridos.', success: false });
    }

    const client = whatsappClients[sub];
    if (!client) {
        return res.status(404).json({ message: `Cliente WhatsApp no encontrado para sub: ${sub}.`, success: false });
    }

    if (!client.info || !client.info.wid) {
        return res.status(400).json({ message: 'Cliente WhatsApp no está autenticado.', success: false });
    }

    try {
        const chatId = `${recipient}@c.us`;
        const sentMessage = await client.sendMessage(chatId, message);
        console.log(`Mensaje enviado a ${recipient}: ${message}`);
        return res.json({ message: 'Mensaje enviado exitosamente.', success: true, sentMessage });
    } catch (error) {
        console.error(`Error al enviar mensaje a ${recipient}:`, error);
        return res.status(500).json({ message: 'Error al enviar el mensaje.', success: false, error: error.message });
    }
});

// Función para obtener el estado del QR (opcional, para otros endpoints)
const getQRCodeStatus = async (sub) => {
    try {
        const params = {
            TableName: 'WhatsAppQRCodes',
            Key: { sub: sub },
            ProjectionExpression: 'estado'
        };
        const command = new GetCommand(params);
        const response = await ddbDocClient.send(command);
        if (response.Item && response.Item.estado) {
            return response.Item.estado;
        } else {
            return null;
        }
    } catch (error) {
        console.error(`Error al obtener el estado del QR para sub ${sub}:`, error);
        return null;
    }
};

// Endpoint para obtener el estado del QR (opcional)
app.get('/qr-status/:sub', async (req, res) => {
    const { sub } = req.params;

    try {
        const estado = await getQRCodeStatus(sub);
        if (estado) {
            return res.json({ sub, estado, success: true });
        } else {
            return res.status(404).json({ message: 'QR no encontrado para el sub proporcionado.', success: false });
        }
    } catch (error) {
        return res.status(500).json({ message: 'Error al obtener el estado del QR.', success: false, error: error.message });
    }
});

// Endpoint para obtener el QR almacenado (opcional)
app.get('/qr/:sub', async (req, res) => {
    const { sub } = req.params;

    try {
        const params = {
            TableName: 'WhatsAppQRCodes',
            Key: { sub: sub },
            ProjectionExpression: 'qrCode'
        };
        const command = new GetCommand(params);
        const response = await ddbDocClient.send(command);
        if (response.Item && response.Item.qrCode) {
            return res.json({ sub, qrCode: response.Item.qrCode, success: true });
        } else {
            return res.status(404).json({ message: 'QR no encontrado para el sub proporcionado.', success: false });
        }
    } catch (error) {
        console.error(`Error al obtener el QR para sub ${sub}:`, error);
        return res.status(500).json({ message: 'Error al obtener el QR.', success: false, error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
});
